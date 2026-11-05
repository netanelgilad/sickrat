import { env, createExecutionContext, fetchMock, waitOnExecutionContext, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import worker from "../src/worker";
import { canonicalApprovalPayload } from "../../../packages/protocol/src/index";

function b64(data: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(data))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
let bindings: typeof env & Record<string, unknown>;
const secret = "s".repeat(43);
async function request(path: string, body?: unknown) {
 const ctx = createExecutionContext();
 const response = await worker.fetch(new Request(`https://vault.example${path}`, body === undefined ? {headers:{authorization:`Bearer ${secret}`}} : {method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${secret}`},body:JSON.stringify(body)}), bindings, ctx);
 await waitOnExecutionContext(ctx); return response;
}

describe("native notification registration and approvals", () => {
 beforeAll(async () => {
   const keys = await crypto.subtle.generateKey({name:"ECDSA", namedCurve:"P-256"}, true, ["sign", "verify"]);
   const pem = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8",keys.privateKey))));
   bindings = {...env,APNS_TEAM_ID:"TEAM123456",APNS_KEY_ID:"KEY1234567",APNS_PRIVATE_KEY:pem,APNS_TOPIC:"example.app",APNS_ENVIRONMENT:"sandbox",APNS_ENROLLMENT_SECRET:secret};
   fetchMock.activate(); fetchMock.disableNetConnect();
 });
 afterAll(() => fetchMock.deactivate());
 it("requires owner approval and scopes a paired credential to one device", async () => {
   const deviceSecret = "d".repeat(43);
   const deviceRequest = (path: string, body?: unknown) => worker.fetch(new Request(`https://vault.example/api/native-push/${path}`, {method:"POST",headers:{authorization:`Bearer ${deviceSecret}`,"content-type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)}),bindings,createExecutionContext());
   const started = await deviceRequest("enroll");
   const pairing = await started.json() as {code:string;approved:number};
   expect(pairing.approved).toBe(0);
   expect((await deviceRequest("register",{token:"d".repeat(64)})).status).toBe(401);
   expect((await deviceRequest("enroll/approve",{code:pairing.code})).status).toBe(401);
   expect((await request("/api/native-push/enroll/approve",{code:pairing.code})).status).toBe(200);
   expect((await request("/api/native-push/enroll/approve",{code:pairing.code})).status).toBe(410);
   expect((await (await deviceRequest("enroll")).json() as {approved:number}).approved).toBe(1);
   const registered = await deviceRequest("register",{token:"d".repeat(64)});
   expect(registered.status).toBe(200);
   expect((await deviceRequest("unregister",{token:"e".repeat(64)})).status).toBe(401);
   expect((await deviceRequest("register",{token:"e".repeat(64)})).status).toBe(401);
   const {id} = await registered.json() as {id:string};
   await request(`/api/native-push/devices/${id}/revoke`,{});
   expect((await deviceRequest("register",{token:"d".repeat(64)})).status).toBe(401);
 });
 it("registers idempotently, sends a generic alert for a signed request without a web subscription, and unregisters", async () => {
   const ctx = createExecutionContext();
   const unauthorized = await worker.fetch(new Request("https://vault.example/api/native-push/devices"), bindings, ctx);
   expect(unauthorized.status).toBe(401);
   for (const path of ["/api/native-push/register", "/api/native-push/unregister", "/api/native-push/devices/550e8400-e29b-41d4-a716-446655440000/revoke"]) {
     const denied = await worker.fetch(new Request(`https://vault.example${path}`, {method:"POST",headers:{"content-type":"application/json"},body:"{}"}), bindings, createExecutionContext());
     expect(denied.status).toBe(401);
   }
   await request("/api/devices");
   await env.DB.prepare("DELETE FROM push_subscriptions").run();
   await env.DB.prepare("DELETE FROM native_push_devices").run();
   const token="a".repeat(64);
   expect((await request("/api/native-push/register", {token:"bad"})).status).toBe(400);
   const registration = await request("/api/native-push/register", {token});
   expect(registration.status).toBe(200);
   const first = await registration.json() as {id:string};
   const duplicate = await request("/api/native-push/register", {token});
   expect((await duplicate.json() as {id:string}).id).toBe(first.id);
   const listing = await request("/api/native-push/devices");
   expect(JSON.stringify(await listing.json())).not.toContain(token);
   expect((await request("/api/native-push/register", {token:"b".repeat(64),id:first.id,previousToken:"c".repeat(64)})).status).toBe(410);
   const sign = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
   const publicKey = await crypto.subtle.exportKey("jwk",sign.publicKey);
   const pairing = await request("/api/devices/pairing-codes", {label:"Test Mac",publicKey});
   const {code,deviceId} = await pairing.json() as {code:string;deviceId:string};
   expect((await request(`/api/devices/pairing-codes/${code}/approve`, {})).status).toBe(200);
   const ephemeral = await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
   const unsigned = {deviceId,command:"test",secretRefs:["test/ref"],resourceRequests:[{type:"secret" as const,ref:"test/ref"}],approvalWaitSeconds:120,ephemeralPublicKey:await crypto.subtle.exportKey("jwk",ephemeral.publicKey),timestamp:new Date().toISOString(),nonce:crypto.randomUUID()};
   const signature = b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},sign.privateKey,new TextEncoder().encode(canonicalApprovalPayload(unsigned))));
   fetchMock.get("https://api.sandbox.push.apple.com").intercept({path:`/3/device/${token}`,method:"POST",body:raw => JSON.parse(String(raw)).aps.badge === 1}).reply(200, "");
   const response = await request("/api/approval-requests", {...unsigned,signature});
   expect(response.status).toBe(200);
   const created = await response.json() as {status:string;requestId:string};
   expect(created.status).toBe("pending");
   expect((await (await request("/api/approvals?status=pending")).json() as {pendingCount:number}).pendingCount).toBe(1);
   expect(fetchMock.pendingInterceptors()).toHaveLength(0);
   const badgeHub = env.APPROVAL_HUB.get(env.APPROVAL_HUB.idFromName("native-icon-badge"));
   // The test passes APNs bindings to fetch directly; the real DO receives them
   // from its deployment. Supply the same bindings to the test instance.
   await runInDurableObject(badgeHub, async (instance, state) => {
     (instance as unknown as {env:typeof bindings}).env = bindings;
     expect(await state.storage.getAlarm()).not.toBeNull();
   });
   const expectClearBadge = () => fetchMock.get("https://api.sandbox.push.apple.com").intercept({
     path:`/3/device/${token}`,method:"POST",body:raw => JSON.stringify(JSON.parse(String(raw))) === JSON.stringify({aps:{badge:0}})
   }).reply(200, "");
   expectClearBadge();
   expect((await request(`/api/approvals/${created.requestId}/deny`,{})).status).toBe(200);
   expect(fetchMock.pendingInterceptors()).toHaveLength(0);
   expect((await (await request("/api/approvals?status=pending")).json() as {pendingCount:number}).pendingCount).toBe(0);
   const another = {...unsigned,nonce:crypto.randomUUID()};
   const anotherSignature = b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},sign.privateKey,new TextEncoder().encode(canonicalApprovalPayload(another))));
   fetchMock.get("https://api.sandbox.push.apple.com").intercept({path:`/3/device/${token}`,method:"POST",body:raw => JSON.parse(String(raw)).aps.badge === 1}).reply(200, "");
   const expiring = await (await request("/api/approval-requests",{...another,signature:anotherSignature})).json() as {requestId:string};
   await env.DB.prepare("UPDATE approval_requests SET created_at = ? WHERE id = ?").bind(new Date(Date.now()-180_000).toISOString(),expiring.requestId).run();
   expect((await (await request("/api/approvals?status=pending")).json() as {pendingCount:number}).pendingCount).toBe(0);
   expectClearBadge();
   expect(await runDurableObjectAlarm(badgeHub)).toBe(true);
   expect(fetchMock.pendingInterceptors()).toHaveLength(0);
   await runInDurableObject(badgeHub, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
   expect((await request(`/api/native-push/devices/${first.id}/revoke`,{})).status).toBe(200);
   expect((await request("/api/native-push/register",{token,id:first.id,previousToken:token})).status).toBe(410);
   expect((await request("/api/native-push/unregister",{token})).status).toBe(200);
   expect(await env.DB.prepare("SELECT id FROM native_push_devices WHERE token = ?").bind(token).first()).toBeNull();
 });
});
