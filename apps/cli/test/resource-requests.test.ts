import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalApprovalPayload } from "@sickrat/protocol";
import { parseBrowserSessionReference, parseSickratUri, resourceRequestForEnv } from "../src/resource-requests.ts";

describe("Sickrat resource URI parsing", () => {
	it("preserves existing static secret refs", () => {
		assert.deepEqual(parseSickratUri("sickrat://default/openai/api-key"), { type: "secret", ref: "default/openai/api-key" });
		assert.equal(parseSickratUri("ordinary-value"), null);
	});

	it("recognizes Cloudflare OAuth requests and repeated scopes", () => {
		const resource = parseSickratUri("sickrat://oauth/cloudflare/personal?scope=workers-platform.write&scope=d1.write");
		assert.deepEqual(resource, { type: "oauth_token", providerId: "cloudflare", connectionName: "personal", scopes: ["workers-platform.write", "d1.write"] });
		assert.deepEqual(resourceRequestForEnv(resource!, "CLOUDFLARE_API_TOKEN"), {
			type: "oauth_token",
			providerId: "cloudflare",
			connectionName: "personal",
			scopes: ["workers-platform.write", "d1.write"],
			env: "CLOUDFLARE_API_TOKEN",
		});
	});

	it("recognizes a named X connection with the minimum read scopes", () => {
		const resource = parseSickratUri("sickrat://oauth/x/personal?scope=tweet.read&scope=users.read");
		assert.deepEqual(resource, { type: "oauth_token", providerId: "x", connectionName: "personal", scopes: ["tweet.read", "users.read"] });
		assert.deepEqual(resourceRequestForEnv(resource!, "X_ACCESS_TOKEN"), {
			type: "oauth_token",
			providerId: "x",
			connectionName: "personal",
			scopes: ["tweet.read", "users.read"],
			env: "X_ACCESS_TOKEN",
		});
	});

	it("keeps provider-only OAuth references as an unambiguous shorthand", () => {
		assert.deepEqual(parseSickratUri("sickrat://oauth/cloudflare?scope=workers-platform.read"), {
			type: "oauth_token",
			providerId: "cloudflare",
			scopes: ["workers-platform.read"],
		});
	});

	it("rejects malformed OAuth descriptors instead of treating them as secrets", () => {
		assert.throws(() => parseSickratUri("sickrat://oauth/cloudflare"), /At least one OAuth scope is required/);
		assert.throws(() => parseSickratUri("sickrat://oauth/cloudflare?scope=d1.write&account=abc"), /Unsupported Sickrat OAuth parameter/);
		assert.throws(() => parseSickratUri("sickrat://user@oauth/cloudflare?scope=d1.write"), /Invalid Sickrat reference URI/);
		assert.throws(() => parseSickratUri("sickrat://oauth/Cloudflare?scope=d1.write"), /Invalid Sickrat OAuth provider URI/);
		assert.throws(() => parseSickratUri("sickrat://oauth/cloudflare/Personal?scope=d1.write"), /Invalid Sickrat OAuth connection URI/);
		assert.throws(() => parseSickratUri("sickrat://oauth/cloudflare/personal/extra?scope=d1.write"), /Invalid Sickrat OAuth provider URI/);
		assert.throws(() => parseSickratUri("sickrat://oauth/cloudflare?scope=%20d1.write"), /At least one OAuth scope is required/);
		assert.throws(() => parseSickratUri("sickrat://default/openai/api-key?scope=nope"), /do not support query parameters/);
	});

	it("parses browser-session references only for the dedicated transaction command", () => {
		assert.deepEqual(parseBrowserSessionReference("chatgpt/primary"), {
			resourceRef: "browser-session/chatgpt/primary",
			uri: "sickrat://browser-session/chatgpt/primary",
		});
		assert.deepEqual(parseBrowserSessionReference("sickrat://browser-session/fair/primary"), {
			resourceRef: "browser-session/fair/primary",
			uri: "sickrat://browser-session/fair/primary",
		});
		assert.throws(() => parseBrowserSessionReference("chatgpt"), /two path segments/);
		assert.throws(() => parseSickratUri("sickrat://browser-session/chatgpt/primary"), /not environment injection/);
	});

	it("binds typed provider requests into the signed approval payload", () => {
		const payload = JSON.parse(canonicalApprovalPayload({
			deviceId: "dev-1",
			command: "atlas-status setup",
			secretRefs: [],
			resourceRequests: [{ type: "oauth_token", providerId: "cloudflare", scopes: ["workers-platform.write"], env: "CLOUDFLARE_API_TOKEN" }],
			ephemeralPublicKey: { kty: "EC" },
			timestamp: "2026-07-11T00:00:00.000Z",
			nonce: "nonce",
		}));
		assert.deepEqual(payload.resourceRequests, [{ type: "oauth_token", providerId: "cloudflare", scopes: ["workers-platform.write"], env: "CLOUDFLARE_API_TOKEN" }]);
	});
});
