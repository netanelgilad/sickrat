import { describe, expect, it, vi } from "vitest";
import { sendAPNs, validAPNsToken } from "../src/worker/apns";

describe("APNs delivery", () => {
  it("signs a sandbox push for the configured topic without sensitive request content", async () => {
    const pair = await crypto.subtle.generateKey({name:"ECDSA", namedCurve:"P-256"}, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
    const fetcher = vi.fn(async () => new Response(null, {status: 200}));
    const token = "a".repeat(64);
    const result = await sendAPNs({teamId:"TEAM123456",keyId:"KEY1234567",privateKey:pem,topic:"example.app",environment:"sandbox"}, token, "request-id", 3, fetcher as typeof fetch);
    expect(result).toEqual({status:200, stale:false});
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.sandbox.push.apple.com/3/device/${token}`);
    const headers = options.headers as Record<string,string>;
    expect(headers["apns-topic"]).toBe("example.app");
    expect(headers["apns-push-type"]).toBe("alert");
    const jwt = headers.authorization.slice(7).split(".");
    const decode = (s:string) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/") + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
    expect(await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, pair.publicKey, decode(jwt[2]), new TextEncoder().encode(`${jwt[0]}.${jwt[1]}`))).toBe(true);
    expect(JSON.parse(options.body as string)).toEqual({aps:{badge:3,alert:{title:"Sickrat",body:"An access request needs your review."},sound:"default"},requestId:"request-id"});
    fetcher.mockClear();
    await sendAPNs({teamId:"TEAM123456",keyId:"KEY1234567",privateKey:pem,topic:"example.app",environment:"sandbox"}, token, null, 0, fetcher as typeof fetch);
    const clearing = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(clearing[1].body as string)).toEqual({aps:{badge:0}});
    fetcher.mockClear();
    await sendAPNs({teamId:"TEAM123456",keyId:"KEY1234567",privateKey:pem,topic:"example.app",environment:"sandbox"}, token, null, 2, fetcher as typeof fetch, "123456");
    const pairing = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(pairing[1].body as string)).toEqual({aps:{badge:2,alert:{title:"Sickrat",body:"A device wants to pair with your vault."},sound:"default"},pairingCode:"123456"});
    expect((pairing[1].headers as Record<string,string>)["apns-collapse-id"]).toBe("sickrat-pairing");
  });
  it("validates tokens and removes only definitively unregistered devices", async () => {
    expect(validAPNsToken("../bad")).toBe(false);
    expect(validAPNsToken("a".repeat(64))).toBe(true);
    const pair = await crypto.subtle.generateKey({name:"ECDSA", namedCurve:"P-256"}, true, ["sign", "verify"]);
    const key = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const config = {teamId:"TEAM123456",keyId:"OTHER12345",privateKey:btoa(String.fromCharCode(...key)),topic:"example.app",environment:"sandbox" as const};
    const unregistered = vi.fn(async () => new Response(JSON.stringify({reason:"Unregistered"}), {status:410}));
    expect((await sendAPNs(config,"b".repeat(64),"id",1,unregistered as typeof fetch)).stale).toBe(true);
    const mismatch = vi.fn(async () => new Response(JSON.stringify({reason:"BadDeviceToken"}), {status:400}));
    expect((await sendAPNs(config,"b".repeat(64),"id",1,mismatch as typeof fetch)).stale).toBe(false);
  });
});
