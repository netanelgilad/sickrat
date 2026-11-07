import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessJobs, accessInput, createMcpHttpServer, createVaultMcpServer, type McpBackend } from "../src/mcp.ts";
import type { GrantPayload } from "@sickrat/protocol";

const tick = () => new Promise(resolve => setImmediate(resolve));
const input = { resources: [{ type: "secret" as const, ref: "service/token" }], message: "Test access", approvalWaitSeconds: 120 };
function fixture() {
	let resolve!: (grant: GrantPayload) => void;
	let reject!: (error: Error) => void;
	let requested: Parameters<McpBackend["request"]>[0] | undefined;
	const pending = new Promise<GrantPayload>((yes, no) => { resolve = yes; reject = no; });
	const backend: McpBackend = {
		status: async () => ({ deviceId: "paired-device" }), providers: async () => [], connections: async () => [],
		request: async args => { requested = args; args.onCreated("approval-id", "https://vault.example/approve/approval-id"); return pending; },
	};
	return { backend, resolve, reject, requested: () => requested };
}

test("approvals are asynchronous, uncached, projected, and collected once", async () => {
	const f = fixture(); const jobs = new AccessJobs(f.backend);
	try {
		const ticket = jobs.start(input).ticket;
		await tick();
		assert.equal(f.requested()?.allowCache, false);
		assert.match(f.requested()!.command, /plaintext/);
		assert.deepEqual(jobs.collect(ticket), { status: "pending", requestId: "approval-id", approvalUrl: "https://vault.example/approve/approval-id" });
		f.resolve({ secrets: { "service/token": "approved-value", unrequested: "excluded" }, approvedAt: new Date().toISOString() });
		await tick();
		const collected = jobs.collect(ticket);
		assert.equal(collected.status, "approved");
		assert.equal(collected.grant?.secrets?.["service/token"], "approved-value");
		assert.equal(collected.grant?.secrets?.unrequested, undefined);
		assert.equal(jobs.collect(ticket).status, "unavailable");
	} finally { jobs.close(); }
});

test("cancel and expiry discard values, including approvals arriving after cancellation", async () => {
	const f = fixture(); let now = Date.now(); const jobs = new AccessJobs(f.backend, () => now);
	try {
		const cancelled = jobs.start(input).ticket; await tick();
		jobs.cancel(cancelled); assert.equal(f.requested()?.signal.aborted, true);
		f.resolve({ secrets: { "service/token": "value" }, approvedAt: new Date().toISOString() }); await tick();
		assert.equal(jobs.collect(cancelled).status, "unavailable");
		const expiring = jobs.start(input).ticket; await tick(); now += 60_001;
		assert.equal(jobs.collect(expiring).status, "unavailable");
	} finally { jobs.close(); }
});

test("backend failures don't leak upstream response bodies", async () => {
	const f = fixture(); const jobs = new AccessJobs(f.backend);
	try {
		const ticket = jobs.start(input).ticket; await tick(); f.reject(new Error("sensitive upstream data")); await tick();
		const result = jobs.collect(ticket); assert.equal(result.status, "failed"); assert.doesNotMatch(JSON.stringify(result), /sensitive/);
	} finally { jobs.close(); }
});

test("invalid inputs and excess outstanding approvals are rejected", () => {
	assert.equal(accessInput.safeParse({ ...input, message: " reason " }).success, false);
	assert.equal(accessInput.safeParse({ ...input, approvalWaitSeconds: 59 }).success, false);
	assert.equal(accessInput.safeParse({ ...input, resources: [{ type: "oauth_token", providerId: "x", scopes: ["a", "a"] }] }).success, false);
	assert.equal(accessInput.safeParse({ ...input, resources: [{ type: "browser_session", ref: "test" }] }).success, false);
	const jobs = new AccessJobs(fixture().backend);
	try { for (let i = 0; i < 20; i++) jobs.start(input); assert.throws(() => jobs.start(input), /Too many/); }
	finally { jobs.close(); }
});

test("SDK discovery and calls work over MCP without exposing credentials", async () => {
	const f = fixture(); const jobs = new AccessJobs(f.backend);
	const server = createVaultMcpServer(f.backend, jobs, "test");
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(a); await client.connect(b);
		const catalog = await client.listTools(); assert.equal(catalog.tools.length, 6);
		assert.equal(catalog.tools.find(tool => tool.name === "collect_access")?.annotations?.readOnlyHint, false);
		const response = await client.callTool({ name: "vault_status", arguments: {} });
		assert.match(JSON.stringify(response), /paired-device/);
		const invalid = await client.callTool({ name: "request_access", arguments: { ...input, message: "" } });
		assert.equal(invalid.isError, true);
	} finally { await client.close(); await server.close(); jobs.close(); }
});

test("HTTP requires bearer auth, validates Host/Origin, and supports SDK stateless calls", async () => {
	const f = fixture(); const jobs = new AccessJobs(f.backend); const token = "a".repeat(43);
	const hosts: string[] = [];
	const server = createMcpHttpServer(f.backend, jobs, "test", token, hosts);
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const host = `127.0.0.1:${address.port}`; hosts.push(host); const url = new URL(`http://${host}/mcp`);
	const client = new Client({ name: "test", version: "1" });
	try {
		assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
		assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status, 401);
		const headers = { authorization: `Bearer ${token}` };
		assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status, 403);
		assert.equal(await new Promise<number | undefined>((resolve, reject) => {
			const req = request(url, { method: "POST", headers: { ...headers, Host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); });
			req.on("error", reject); req.end("{}");
		}), 403);
		assert.equal((await fetch(url, { headers })).status, 405);
		assert.equal((await fetch(url, { method: "POST", headers, body: "invalid" })).status, 400);
		assert.equal((await fetch(url, { method: "POST", headers, body: "x".repeat(65537) })).status, 413);
		await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
		assert.equal((await client.listTools()).tools.length, 6);
		const response = await client.callTool({ name: "request_access", arguments: input });
		assert.match(JSON.stringify(response), /pending/);
	} finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); jobs.close(); }
});

test("OAuth collection binds requested resources and respects provider expiry", async () => {
	const f = fixture(); let now = Date.now(); const jobs = new AccessJobs(f.backend, () => now);
	try {
		const ticket = jobs.start({ resources: [{ type: "oauth_token", providerId: "x", connectionName: "personal", scopes: ["tweet.read"] }], message: "Read tweets", approvalWaitSeconds: 120 }).ticket;
		await tick();
		assert.deepEqual(f.requested()?.resourceRequests, [{ type: "oauth_token", providerId: "x", connectionName: "personal", scopes: ["tweet.read"], env: "MCP_TOKEN_0" }]);
		f.resolve({ approvedAt: new Date(now).toISOString(), oauthTokens: { MCP_TOKEN_0: { providerId: "x", connectionId: "connection", connectionName: "personal", scopes: ["tweet.read"], accessToken: "token", tokenType: "Bearer", expiresAt: new Date(now + 1000).toISOString() } } });
		await tick(); now += 1001;
		assert.equal(jobs.collect(ticket).status, "unavailable");
	} finally { jobs.close(); }
});

test("pending jobs expire and wrong OAuth providers cannot be collected", async () => {
	const f = fixture(); let now = Date.now(); const jobs = new AccessJobs(f.backend, () => now);
	try {
		const ticket = jobs.start(input).ticket; await tick(); now += 120_001;
		assert.equal(jobs.collect(ticket).status, "unavailable"); assert.equal(f.requested()?.signal.aborted, true);
		const other = jobs.start({ ...input, resources: [{ type: "oauth_token", providerId: "x", scopes: ["tweet.read"] }] }).ticket;
		await tick();
		f.resolve({ approvedAt: new Date(now).toISOString(), oauthTokens: { MCP_TOKEN_0: { providerId: "other", connectionId: "c", scopes: ["tweet.read"], accessToken: "token", tokenType: "Bearer" } } });
		await tick(); assert.equal(jobs.collect(other).status, "failed");
	} finally { jobs.close(); }
});
