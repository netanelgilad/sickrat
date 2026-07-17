import { env, createExecutionContext, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { canonicalApprovalPayload } from "../../../packages/protocol/src/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker";

async function request(path: string, init?: RequestInit) {
	const context = createExecutionContext();
	const response = await worker.fetch(new Request(`https://vault.example${path}`, init), env, context);
	await waitOnExecutionContext(context);
	return response;
}

function bytesToBase64Url(value: ArrayBuffer) {
	let binary = "";
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("OAuth gateway Worker API", () => {
	beforeEach(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await request("/api/oauth/providers");
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it("publishes a generic Cloudflare provider descriptor", async () => {
		const response = await request("/api/oauth/providers");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { providers: Array<Record<string, unknown>> };
		expect(body.providers).toContainEqual(
			expect.objectContaining({
				id: "cloudflare",
				configured: false,
				redirectUri: "https://vault.example/oauth/callback/cloudflare",
				identityScopes: ["user-details.read"],
			}),
		);
	});

	it("stores a provider client ID independently from owner login", async () => {
		const saved = await request("/api/oauth/providers/cloudflare/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "gateway-client-id" }),
		});
		expect(saved.status).toBe(200);
		const body = (await saved.json()) as { provider: { clientId: string; configured: boolean } };
		expect(body.provider).toEqual(expect.objectContaining({ clientId: "gateway-client-id", configured: true }));
	});

	it("exchanges a PKCE authorization code through the generic provider adapter", async () => {
		await request("/api/oauth/providers/cloudflare/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "gateway-client-id" }),
		});
		fetchMock
			.get("https://dash.cloudflare.com")
			.intercept({
				path: "/oauth2/token",
				method: "POST",
				body: (body) => {
					const params = new URLSearchParams(body);
					return (
						params.get("grant_type") === "authorization_code" &&
						params.get("client_id") === "gateway-client-id" &&
						params.get("code") === "authorization-code" &&
						params.get("code_verifier") === "pkce-verifier" &&
						params.get("redirect_uri") === "https://vault.example/oauth/callback/cloudflare"
					);
				},
			})
			.reply(200, {
				access_token: "access-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "user-details.read workers-platform.read",
			});

		const response = await request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "authorization_code",
				providerId: "cloudflare",
				code: "authorization-code",
				codeVerifier: "pkce-verifier",
				redirectUri: "https://vault.example/oauth/callback/cloudflare",
				scopes: ["user-details.read", "workers-platform.read"],
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			accessToken: "access-token",
			refreshToken: "refresh-token",
			expiresIn: 3600,
			tokenType: "Bearer",
			scopes: ["user-details.read", "workers-platform.read"],
		});
	});

	it("mints a fresh access token without persisting the plaintext refresh token", async () => {
		await request("/api/oauth/providers/cloudflare/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "gateway-client-id" }),
		});
		const savedConnectionResponse = await request("/api/oauth/connections", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerId: "cloudflare",
				accountLabel: "refresh@example.com",
				accountSubject: "refresh-user",
				grantedScopes: ["user-details.read", "workers-platform.read"],
				tokenType: "Bearer",
				refreshTokenCiphertext: "encrypted-refresh-token",
				refreshTokenIv: "encrypted-iv",
				refreshTokenSalt: "vault-fingerprint",
				refreshTokenKdf: "AES-256-GCM:local-vault-key:v1",
			}),
		});
		const connectionId = ((await savedConnectionResponse.json()) as { connection: { id: string } }).connection.id;
		fetchMock
			.get("https://dash.cloudflare.com")
			.intercept({
				path: "/oauth2/token",
				method: "POST",
				body: (body) => {
					const params = new URLSearchParams(body);
					return (
						params.get("grant_type") === "refresh_token" &&
						params.get("client_id") === "gateway-client-id" &&
						params.get("refresh_token") === "plaintext-refresh-token"
					);
				},
			})
			.reply(200, {
				access_token: "fresh-access-token",
				expires_in: 1800,
				token_type: "Bearer",
				scope: "user-details.read workers-platform.read",
			});

		const response = await request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "refresh_token",
				providerId: "cloudflare",
				refreshToken: "plaintext-refresh-token",
				scopes: ["user-details.read", "workers-platform.read"],
				connectionId,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			accessToken: "fresh-access-token",
			expiresIn: 1800,
			tokenType: "Bearer",
			scopes: ["user-details.read", "workers-platform.read"],
		});
		const listed = await request("/api/oauth/connections");
		const listedBody = (await listed.json()) as { connections: Array<Record<string, unknown>> };
		const saved = listedBody.connections.find((connection) => connection.id === connectionId);
		expect(saved?.lastUsedAt).toEqual(expect.any(String));
		expect(JSON.stringify(saved)).not.toContain("plaintext-refresh-token");
	});

	it("accepts a signed typed OAuth request from a paired CLI device", async () => {
		const signingKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
		const publicKey = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
		const pairingResponse = await request("/api/devices/pairing-codes", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ label: "OAuth test CLI", publicKey }),
		});
		const pairing = (await pairingResponse.json()) as { code: string; deviceId: string };
		expect((await request(`/api/devices/pairing-codes/${pairing.code}/approve`, { method: "POST" })).status).toBe(200);
		const subscriptionResponse = await request("/api/push/subscribe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				subscription: {
					endpoint: "https://push.example/oauth-test",
					keys: { p256dh: "test-p256dh", auth: "test-auth" },
				},
			}),
		});
		expect(subscriptionResponse.status).toBe(200);

		const ephemeralKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const unsigned = {
			deviceId: pairing.deviceId,
			command: "sickrat run -- wrangler deployments list",
			message: "Verify the deployed Workers.",
			secretRefs: [],
			resourceRequests: [
				{
					type: "oauth_token" as const,
					providerId: "cloudflare",
					scopes: ["account-settings.read", "workers-platform.read"],
					env: "CLOUDFLARE_API_TOKEN",
				},
			],
			approvalWaitSeconds: 120,
			ephemeralPublicKey: await crypto.subtle.exportKey("jwk", ephemeralKeys.publicKey),
			timestamp: new Date().toISOString(),
			nonce: "signed-oauth-request",
		};
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			signingKeys.privateKey,
			new TextEncoder().encode(canonicalApprovalPayload(unsigned)),
		);
		const createdResponse = await request("/api/approval-requests", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...unsigned, signature: bytesToBase64Url(signature) }),
		});
		expect(createdResponse.status).toBe(200);
		const created = (await createdResponse.json()) as { requestId: string };
		const approvalResponse = await request(`/api/approvals/${created.requestId}`);
		const approval = (await approvalResponse.json()) as { approval: { secretRefs: string[]; resourceRequests: unknown[] } };
		expect(approval.approval.secretRefs).toEqual([]);
		expect(approval.approval.resourceRequests).toEqual(unsigned.resourceRequests);
	});

	it("stores only encrypted refresh-token material and supports revocation", async () => {
		const saved = await request("/api/oauth/connections", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerId: "cloudflare",
				accountLabel: "owner@example.com",
				accountSubject: "user-123",
				grantedScopes: ["user-details.read", "workers-platform.read"],
				tokenType: "bearer",
				refreshTokenCiphertext: "encrypted-value",
				refreshTokenIv: "encrypted-iv",
				refreshTokenSalt: "vault-fingerprint",
				refreshTokenKdf: "AES-256-GCM:local-vault-key:v1",
			}),
		});
		expect(saved.status).toBe(200);
		const connection = ((await saved.json()) as { connection: { id: string } }).connection;

		const listed = await request("/api/oauth/connections");
		const listedBody = (await listed.json()) as { connections: Array<Record<string, unknown>> };
		expect(listedBody.connections[0]).not.toHaveProperty("refreshTokenCiphertext");

		const resolved = await request(`/api/oauth/connections/${connection.id}/resolve`);
		const resolvedBody = (await resolved.json()) as { connection: { refreshTokenCiphertext: string } };
		expect(resolvedBody.connection.refreshTokenCiphertext).toBe("encrypted-value");

		const revoked = await request(`/api/oauth/connections/${connection.id}/revoke`, { method: "POST" });
		expect(revoked.status).toBe(200);
		expect((await request(`/api/oauth/connections/${connection.id}/resolve`)).status).toBe(404);
	});
});
