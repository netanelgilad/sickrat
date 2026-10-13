import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { canonicalApprovalPayload } from "@sickrat/protocol";

it("real CLI enforces local synthetic reuse policy before dummy environment injection", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sickrat-reuse-runtime-"));
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const privateKey = await crypto.subtle.exportKey("jwk", keys.privateKey);
	const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
	let mode = "active";
	let checks = 0;
	let approvals = 0;
	const server = createServer(async (request, response) => {
		if (request.url !== "/api/approvals/synthetic-request/reuse-status") {
			approvals += 1;
			response.writeHead(404).end();
			return;
		}
		checks += 1;
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString());
		const { signature, ...unsigned } = body;
		const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(canonicalApprovalPayload(unsigned)));
		if (!valid || body.command !== "sickrat grant-status synthetic-request") {
			response.writeHead(403).end();
			return;
		}
		response.setHeader("content-type", "application/json");
		if (mode === "500") { response.writeHead(500).end(JSON.stringify({ error: "synthetic control-plane failure" })); return; }
		response.end(JSON.stringify({ workerUrl, deviceId: mode === "mismatch" ? "another-device" : "synthetic-device", requestId: "synthetic-request", state: mode === "revoked" ? "revoked" : "active", checkedAt: new Date(mode === "stale" ? Date.now() - 60000 : Date.now()).toISOString() }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	const workerUrl = `http://127.0.0.1:${address.port}`;
	const approvedAt = new Date(Date.now() - 60000).toISOString();
	const expiresAt = new Date(Date.now() + 60000).toISOString();
	const dummy = "synthetic-dummy-value-never-log";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sickrat:grant-cache:v1:${privateKey.d}`));
	const cacheKey = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cacheKey, new TextEncoder().encode(JSON.stringify({ requestId: "synthetic-request", secrets: { "synthetic/item-a": dummy }, approvedAt, accessExpiresAt: expiresAt })));
	const policy = { enabled: true, workerUrl, deviceId: "synthetic-device", requestId: "synthetic-request", resources: [{ type: "secret", ref: "synthetic/item-a", env: "DUMMY" }], approvalOpensAt: new Date(Date.now() - 120000).toISOString(), approvalClosesAt: new Date(Date.now() - 10000).toISOString(), accessExpiresAt: expiresAt, maxStatusAgeMs: 5000 };
	const policyPath = join(directory, "policy.json");
	const stateDir = join(directory, ".sickrat");
	try {
		await mkdir(stateDir);
		await writeFile(join(stateDir, "config.json"), JSON.stringify({ workerUrl, deviceId: "synthetic-device", signingPrivateKey: privateKey, signingPublicKey: publicKey }));
		await writeFile(join(stateDir, "grant-cache.json"), JSON.stringify({ version: 2, entries: [{ workerUrl, deviceId: "synthetic-device", requestId: "synthetic-request", resourceKeys: ["secret:synthetic/item-a"], grantIv: Buffer.from(iv).toString("base64url"), grantCiphertext: Buffer.from(encrypted).toString("base64url"), approvedAt, expiresAt, command: "synthetic" }] }));
		await writeFile(policyPath, JSON.stringify(policy));
		const run = async () => {
			const cli = process.env.SICKRAT_TEST_CLI_BINARY;
			const expectedHash = createHash("sha256").update(dummy).digest("hex");
			const child = spawn(cli ?? "bun", [...(cli ? [] : [fileURLToPath(new URL("../src/index.ts", import.meta.url))]), "run", "--reuse-policy", policyPath, "--env", "DUMMY=synthetic/item-a", "--", process.execPath, "-e", `if(require('node:crypto').createHash('sha256').update(process.env.DUMMY||'').digest('hex')!=='${expectedHash}')process.exit(3);console.log('synthetic-child-ok')`], { env: { PATH: process.env.PATH, HOME: directory }, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", chunk => { output += chunk; });
			child.stderr.on("data", chunk => { output += chunk; });
			const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
			assert.ok(!output.includes(dummy));
			return { code, output };
		};
		const active = await run();
		assert.equal(active.code, 0, active.output);
		assert.match(active.output, /synthetic-child-ok/);
		for (const rejected of ["revoked", "mismatch", "stale", "500"]) {
			mode = rejected;
			const result = await run();
			assert.equal(result.code, 1, result.output);
			assert.doesNotMatch(result.output, /synthetic-child-ok/);
			assert.match(result.output, rejected === "500" ? /control-plane failure/ : /Grant reuse policy rejected/);
		}
		const beforeDisabled = checks;
		mode = "active";
		await writeFile(policyPath, JSON.stringify({ ...policy, resources: [{ type: "secret", ref: "synthetic/item-other" }] }));
		assert.match((await run()).output, /resource-mismatch/);
		await writeFile(policyPath, JSON.stringify({ ...policy, accessExpiresAt: new Date(Date.now()).toISOString() }));
		assert.match((await run()).output, /access-expired/);
		const afterBoundaries = checks;
		await writeFile(policyPath, JSON.stringify({ ...policy, enabled: false }));
		assert.equal((await run()).code, 1);
		assert.equal(checks, afterBoundaries);
		assert.equal(afterBoundaries, beforeDisabled + 2);
		assert.equal(approvals, 0);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
