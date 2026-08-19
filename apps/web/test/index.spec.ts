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

async function sha256Base64Url(value: string) {
	return bytesToBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function base64UrlToBytes(value: string) {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function createPairedDevice(label: string) {
	const signingKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
	const pairingResponse = await request("/api/devices/pairing-codes", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ label, publicKey }),
	});
	const pairing = (await pairingResponse.json()) as { code: string; deviceId: string };
	expect((await request(`/api/devices/pairing-codes/${pairing.code}/approve`, { method: "POST" })).status).toBe(200);
	const subscriptionResponse = await request("/api/push/subscribe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			subscription: {
				endpoint: `https://push.example/${crypto.randomUUID()}`,
				keys: { p256dh: "test-p256dh", auth: "test-auth" },
			},
		}),
	});
	expect(subscriptionResponse.status).toBe(200);
	return { signingKeys, deviceId: pairing.deviceId };
}

async function createSignedApproval(
	device: Awaited<ReturnType<typeof createPairedDevice>>,
	resourceRequest: {
		type: "browser_session";
		resourceRef: string;
		access: "create" | "restore" | "restore_and_update" | "replace";
	},
) {
	const ephemeralKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const unsigned = {
		deviceId: device.deviceId,
		command: `synthetic ${resourceRequest.access}`,
		message: "Exercise the browser-free session transaction.",
		secretRefs: [],
		resourceRequests: [resourceRequest],
		approvalWaitSeconds: 120,
		ephemeralPublicKey: await crypto.subtle.exportKey("jwk", ephemeralKeys.publicKey),
		timestamp: new Date().toISOString(),
		nonce: crypto.randomUUID(),
	};
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		device.signingKeys.privateKey,
		new TextEncoder().encode(canonicalApprovalPayload(unsigned)),
	);
	const createdResponse = await request("/api/approval-requests", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...unsigned, signature: bytesToBase64Url(signature) }),
	});
	expect(createdResponse.status).toBe(200);
	return ((await createdResponse.json()) as { requestId: string }).requestId;
}

async function authorizeBrowserSessionApproval(input: {
	requestId: string;
	sessionId: string;
	resourceRef: string;
	capability: string;
	create?: boolean;
	expectedStatus?: number;
}) {
	const expiresAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
	const response = await request(`/api/approvals/${input.requestId}/grant`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grantCiphertext: { opaque: true },
			browserSessionAuthorization: {
				sessionId: input.sessionId,
				resourceRef: input.resourceRef,
				transactionCapabilityHash: await sha256Base64Url(input.capability),
				expiresAt,
				...(input.create
					? {
							wrappedDataKey: "phone-wrapped-record-key",
							wrappedDataKeyIv: "wrapped-key-iv",
							wrappedDataKeyKdf: "AES-256-GCM:local-vault-key:v1",
							encryptionAlgorithm: "AES-256-GCM",
						}
					: {}),
			},
		}),
	});
	expect(response.status).toBe(input.expectedStatus ?? 200);
	return expiresAt;
}

function browserSessionAuthorization(capability: string) {
	return { authorization: `SickratBrowserSession ${capability}` };
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
		const body = (await response.json()) as { providers: Array<Record<string, unknown> & { scopes?: Array<{ id: string }> }> };
		expect(body.providers).toContainEqual(
			expect.objectContaining({
				id: "cloudflare",
				configured: false,
				redirectUri: "https://vault.example/oauth/callback/cloudflare",
				identityScopes: ["user-details.read"],
				connectionScopes: ["offline_access"],
			}),
		);
		const cloudflare = body.providers.find((provider) => provider.id === "cloudflare");
		expect(cloudflare?.scopes?.map((scope) => scope.id)).toEqual(expect.arrayContaining([
			"workers-scripts.read",
			"workers-scripts.write",
			"workers-routes.read",
			"workers-routes.write",
			"workers-r2-storage.read",
			"workers-r2-storage.write",
		]));
	});

	it("publishes the minimal public-client X provider descriptor", async () => {
		const response = await request("/api/oauth/providers");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			providers: Array<Record<string, unknown> & { scopes?: Array<{ id: string; risk: string }> }>;
		};
		const x = body.providers.find((provider) => provider.id === "x");
		expect(x).toEqual(
			expect.objectContaining({
				name: "X",
				authorizationEndpoint: "https://x.com/i/oauth2/authorize",
				configured: false,
				redirectUri: "https://vault.example/oauth/callback/x",
				identityScopes: ["users.read", "tweet.read"],
				connectionScopes: ["offline.access"],
				supportsPkce: true,
				supportsRefreshToken: true,
			}),
		);
		expect(x?.scopes?.map((scope) => scope.id)).toEqual(["users.read", "tweet.read", "offline.access", "tweet.write"]);
		expect(x?.scopes?.find((scope) => scope.id === "tweet.write")?.risk).toBe("sensitive");
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

	it("rejects invalid provider client IDs", async () => {
		for (const clientId of ["", " leading-space", "trailing-space ", "x".repeat(513)]) {
			const response = await request("/api/oauth/providers/x/config", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ clientId }),
			});
			expect(response.status).toBe(400);
		}
	});

	it("relays a browser callback to the PWA as a one-time encrypted handoff", async () => {
		const handoffId = "handoff_abcdefghijklmnop";
		const handoffKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const handoffPublicKey = await crypto.subtle.exportKey("jwk", handoffKeys.publicKey);
		const state = `v1.${handoffId}.nonce_abcdefghijklmnop`;
		const created = await request("/api/oauth/handoffs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: handoffId, providerId: "cloudflare", stateHash: await sha256Base64Url(state), publicKey: handoffPublicKey }),
		});
		expect(created.status).toBe(201);

		const callback = await request(`/oauth/callback/cloudflare?code=one-time-code&state=${encodeURIComponent(state)}`);
		expect(callback.status).toBe(200);
		const callbackHtml = await callback.text();
		expect(callbackHtml).toContain("Cloudflare response received");
		expect(callbackHtml).toContain("does not yet confirm that every requested scope was granted");
		expect(callbackHtml).not.toContain("one-time-code");

		const polled = await request(`/api/oauth/handoffs/${handoffId}`);
		const result = (await polled.json()) as { status: string; ciphertext: string; iv: string; ephemeralPublicKey: JsonWebKey };
		expect(result.status).toBe("completed");
		expect(JSON.stringify(result)).not.toContain("one-time-code");
		const ephemeralPublicKey = await crypto.subtle.importKey("jwk", result.ephemeralPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
		const sharedSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublicKey }, handoffKeys.privateKey, 256);
		const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
		const key = await crypto.subtle.deriveKey(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: new TextEncoder().encode("sickrat:oauth-handoff-salt:v1"),
				info: new TextEncoder().encode("sickrat:oauth-handoff:v1"),
			},
			hkdfKey,
			{ name: "AES-GCM", length: 256 },
			false,
			["decrypt"],
		);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: base64UrlToBytes(result.iv) },
			key,
			base64UrlToBytes(result.ciphertext),
		);
		expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(expect.objectContaining({ providerId: "cloudflare", state, code: "one-time-code" }));

		expect((await request(`/api/oauth/handoffs/${handoffId}`, { method: "DELETE" })).status).toBe(200);
		expect((await request(`/api/oauth/handoffs/${handoffId}`)).status).toBe(404);
	});

	it("routes an X callback through the generic encrypted handoff", async () => {
		const handoffId = "handoff_x_abcdefghijkl";
		const handoffKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const state = `v1.${handoffId}.nonce_x_abcdefghijkl`;
		const created = await request("/api/oauth/handoffs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: handoffId,
				providerId: "x",
				stateHash: await sha256Base64Url(state),
				publicKey: await crypto.subtle.exportKey("jwk", handoffKeys.publicKey),
			}),
		});
		expect(created.status).toBe(201);

		const callback = await request(`/oauth/callback/x?code=x-code&state=${encodeURIComponent(state)}`);
		expect(callback.status).toBe(200);
		expect(await callback.text()).toContain("X response received");
		const polled = await request(`/api/oauth/handoffs/${handoffId}`);
		expect(await polled.json()).toEqual(expect.objectContaining({ providerId: "x", status: "completed" }));
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

	it("exchanges and refreshes X tokens as a public PKCE client", async () => {
		await request("/api/oauth/providers/x/config", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: "x-public-client-id" }),
		});
		fetchMock
			.get("https://api.x.com")
			.intercept({
				path: "/2/oauth2/token",
				method: "POST",
				body: (body) => {
					const params = new URLSearchParams(body);
					return (
						params.get("grant_type") === "authorization_code" &&
						params.get("client_id") === "x-public-client-id" &&
						params.get("code") === "x-authorization-code" &&
						params.get("code_verifier") === "x-pkce-verifier" &&
						params.get("redirect_uri") === "https://vault.example/oauth/callback/x" &&
						!params.has("client_secret")
					);
				},
			})
			.reply(200, {
				access_token: "x-access-token",
				refresh_token: "x-refresh-token",
				expires_in: 7200,
				token_type: "bearer",
				scope: "tweet.read users.read offline.access",
			});

		const exchange = await request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "authorization_code",
				providerId: "x",
				code: "x-authorization-code",
				codeVerifier: "x-pkce-verifier",
				redirectUri: "https://vault.example/oauth/callback/x",
				scopes: ["tweet.read", "users.read", "offline.access"],
			}),
		});
		expect(exchange.status).toBe(200);
		expect(await exchange.json()).toEqual({
			accessToken: "x-access-token",
			refreshToken: "x-refresh-token",
			expiresIn: 7200,
			tokenType: "bearer",
			scopes: ["tweet.read", "users.read", "offline.access"],
		});

		fetchMock
			.get("https://api.x.com")
			.intercept({
				path: "/2/oauth2/token",
				method: "POST",
				body: (body) => {
					const params = new URLSearchParams(body);
					return (
						params.get("grant_type") === "refresh_token" &&
						params.get("client_id") === "x-public-client-id" &&
						params.get("refresh_token") === "x-refresh-token" &&
						!params.has("client_secret")
					);
				},
			})
			.reply(200, {
				access_token: "fresh-x-access-token",
				refresh_token: "rotated-x-refresh-token",
				expires_in: 7200,
				token_type: "bearer",
				scope: "tweet.read users.read offline.access",
			});

		const refresh = await request("/api/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "refresh_token",
				providerId: "x",
				refreshToken: "x-refresh-token",
				scopes: ["tweet.read", "users.read", "offline.access"],
			}),
		});
		expect(refresh.status).toBe(200);
		expect(await refresh.json()).toEqual(expect.objectContaining({
			accessToken: "fresh-x-access-token",
			refreshToken: "rotated-x-refresh-token",
			scopes: ["tweet.read", "users.read", "offline.access"],
		}));
	});

	it("inspects X account identity through users/me", async () => {
		fetchMock
			.get("https://api.x.com")
			.intercept({
				path: "/2/users/me",
				method: "GET",
				headers: { authorization: "Bearer x-access-token", accept: "application/json" },
			})
			.reply(200, { data: { id: "2244994945", name: "X Developers", username: "XDevelopers" } });

		const response = await request("/api/oauth/identity", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerId: "x", accessToken: "x-access-token" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ identity: { subject: "2244994945", label: "XDevelopers" } });
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
				connectionName: "refresh-test",
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
					connectionName: "work",
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
				connectionName: "personal",
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
		expect(listedBody.connections[0]?.connectionName).toBe("personal");
		expect(listedBody.connections[0]).not.toHaveProperty("refreshTokenCiphertext");

		const duplicate = await request("/api/oauth/connections", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerId: "cloudflare",
				connectionName: "personal",
				accountLabel: "other@example.com",
				accountSubject: "user-456",
				grantedScopes: ["user-details.read"],
				tokenType: "bearer",
				refreshTokenCiphertext: "encrypted-other",
				refreshTokenIv: "encrypted-iv",
				refreshTokenSalt: "vault-fingerprint",
				refreshTokenKdf: "AES-256-GCM:local-vault-key:v1",
			}),
		});
		expect(duplicate.status).toBe(409);

		const renamed = await request(`/api/oauth/connections/${connection.id}/name`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ connectionName: "work" }),
		});
		expect(renamed.status).toBe(200);
		expect(((await renamed.json()) as { connection: { connectionName: string } }).connection.connectionName).toBe("work");

		const resolved = await request(`/api/oauth/connections/${connection.id}/resolve`);
		const resolvedBody = (await resolved.json()) as { connection: { refreshTokenCiphertext: string } };
		expect(resolvedBody.connection.refreshTokenCiphertext).toBe("encrypted-value");

		const revoked = await request(`/api/oauth/connections/${connection.id}/revoke`, { method: "POST" });
		expect(revoked.status).toBe(200);
		expect((await request(`/api/oauth/connections/${connection.id}/resolve`)).status).toBe(404);
	});

	it("creates, restores, conditionally replaces, aborts, and revokes an opaque synthetic browser session", async () => {
		const device = await createPairedDevice("Synthetic browser-session CLI");
		const suffix = crypto.randomUUID().slice(0, 8);
		const resourceRef = `browser-session/synthetic/${suffix}`;
		const sessionId = crypto.randomUUID();
		const createCapability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
		const createRequestId = await createSignedApproval(device, { type: "browser_session", resourceRef, access: "create" });
		await authorizeBrowserSessionApproval({
			requestId: createRequestId,
			sessionId,
			resourceRef,
			capability: createCapability,
			create: true,
		});

		const originalCiphertext = new TextEncoder().encode("opaque-encrypted-artifact-one");
		const created = await request(`/api/browser-sessions/${sessionId}/artifact`, {
			method: "PUT",
			headers: {
				...browserSessionAuthorization(createCapability),
				"content-type": "application/octet-stream",
			},
			body: originalCiphertext,
		});
		expect(created.status).toBe(200);
		expect(JSON.stringify(await created.json())).not.toContain("phone-wrapped-record-key");

		const listed = await request("/api/browser-sessions");
		const listedBody = (await listed.json()) as { browserSessions: Array<Record<string, unknown>> };
		const metadata = listedBody.browserSessions.find((session) => session.id === sessionId);
		expect(metadata).toEqual(expect.objectContaining({ resourceRef, state: "healthy" }));
		expect(metadata).not.toHaveProperty("wrappedDataKey");
		expect(metadata).not.toHaveProperty("artifactBytes");

		const updateCapability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
		const updateRequestId = await createSignedApproval(device, { type: "browser_session", resourceRef, access: "restore_and_update" });
		await authorizeBrowserSessionApproval({
			requestId: updateRequestId,
			sessionId,
			resourceRef,
			capability: updateCapability,
		});
		const conflictingCapability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
		const conflictingRequestId = await createSignedApproval(device, { type: "browser_session", resourceRef, access: "restore_and_update" });
		await authorizeBrowserSessionApproval({
			requestId: conflictingRequestId,
			sessionId,
			resourceRef,
			capability: conflictingCapability,
			expectedStatus: 409,
		});
		const restored = await request(`/api/browser-sessions/${sessionId}/artifact`, {
			headers: browserSessionAuthorization(updateCapability),
		});
		expect(restored.status).toBe(200);
		expect(new Uint8Array(await restored.arrayBuffer())).toEqual(originalCiphertext);

		const replacementCiphertext = new TextEncoder().encode("opaque-encrypted-artifact-two");
		const replaced = await request(`/api/browser-sessions/${sessionId}/artifact`, {
			method: "PUT",
			headers: {
				...browserSessionAuthorization(updateCapability),
				"content-type": "application/octet-stream",
			},
			body: replacementCiphertext,
		});
		expect(replaced.status).toBe(200);
		expect((await request(`/api/browser-sessions/${sessionId}/artifact`, {
			headers: browserSessionAuthorization(updateCapability),
		})).status).toBe(403);

		const abortCapability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
		const abortRequestId = await createSignedApproval(device, { type: "browser_session", resourceRef, access: "restore_and_update" });
		await authorizeBrowserSessionApproval({
			requestId: abortRequestId,
			sessionId,
			resourceRef,
			capability: abortCapability,
		});
		const abortRestore = await request(`/api/browser-sessions/${sessionId}/artifact`, {
			headers: browserSessionAuthorization(abortCapability),
		});
		expect(abortRestore.status).toBe(200);
		await abortRestore.arrayBuffer();
		expect((await request(`/api/browser-sessions/${sessionId}/abort`, {
			method: "POST",
			headers: {
				...browserSessionAuthorization(abortCapability),
				"content-type": "application/json",
			},
			body: JSON.stringify({ safeReasonCode: "unchanged" }),
		})).status).toBe(200);
		expect((await request(`/api/browser-sessions/${sessionId}/artifact`, {
			method: "PUT",
			headers: {
				...browserSessionAuthorization(abortCapability),
				"content-type": "application/octet-stream",
			},
			body: new TextEncoder().encode("must-not-commit"),
		})).status).toBe(403);

		const restoreCapability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
		const restoreRequestId = await createSignedApproval(device, { type: "browser_session", resourceRef, access: "restore" });
		await authorizeBrowserSessionApproval({
			requestId: restoreRequestId,
			sessionId,
			resourceRef,
			capability: restoreCapability,
		});
		const readOnlyRestore = await request(`/api/browser-sessions/${sessionId}/artifact`, {
			headers: browserSessionAuthorization(restoreCapability),
		});
		expect(readOnlyRestore.status).toBe(200);
		await readOnlyRestore.arrayBuffer();
		expect((await request(`/api/browser-sessions/${sessionId}/artifact`, {
			headers: browserSessionAuthorization(restoreCapability),
		})).status).toBe(409);
		expect((await request(`/api/browser-sessions/${sessionId}/abort`, {
			method: "POST",
			headers: {
				...browserSessionAuthorization(restoreCapability),
				"content-type": "application/json",
			},
			body: JSON.stringify({ safeReasonCode: "unchanged" }),
		})).status).toBe(200);
		expect((await request(`/api/browser-sessions/${sessionId}/artifact`, {
			headers: browserSessionAuthorization(restoreCapability),
		})).status).toBe(403);

		expect((await request(`/api/browser-sessions/${sessionId}/revoke`, { method: "POST" })).status).toBe(200);
		const afterRevoke = await request("/api/browser-sessions");
		const revoked = ((await afterRevoke.json()) as { browserSessions: Array<Record<string, unknown>> }).browserSessions.find((session) => session.id === sessionId);
		expect(revoked).toEqual(expect.objectContaining({ state: "revoked", artifactEtag: null }));
		expect(await env.BROWSER_SESSION_ARTIFACTS.head(`browser-session-artifacts/${sessionId}/current`)).toBeNull();
	});
});
