import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	cloudflareTokenEndpoint,
	isCloudflareAuthenticationError,
	refreshCloudflareOAuth,
	retryCloudflareAuthentication,
	shouldRefreshCloudflareOAuth,
	type CloudflareOAuthState,
} from "../src/cloudflare-auth.ts";

const now = Date.parse("2026-08-19T07:00:00.000Z");
const state: CloudflareOAuthState = {
	clientId: "public-client-id",
	accessToken: "old-access-token",
	refreshToken: "old-refresh-token",
	expiresAt: new Date(now + 3_600_000).toISOString(),
	scope: "account-settings.read",
	tokenType: "bearer",
	loggedInAt: "2026-08-19T06:00:00.000Z",
};

describe("Cloudflare owner OAuth refresh", () => {
	it("refreshes shortly before expiry but leaves active sessions alone", () => {
		assert.equal(shouldRefreshCloudflareOAuth(state, now), false);
		assert.equal(shouldRefreshCloudflareOAuth({ ...state, expiresAt: new Date(now + 30_000).toISOString() }, now), true);
		assert.equal(shouldRefreshCloudflareOAuth({ ...state, expiresAt: "invalid" }, now), true);
	});

	it("uses the public-client refresh grant and persists rotated token metadata", async () => {
		let requestUrl = "";
		let requestBody = "";
		const refreshed = await refreshCloudflareOAuth(state, {
			now,
			fetchImpl: async (input, init) => {
				requestUrl = String(input);
				requestBody = String(init?.body);
				return new Response(JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "rotated-refresh-token",
					expires_in: 7_200,
					scope: "account-settings.read d1.write",
					token_type: "Bearer",
				}), { status: 200, headers: { "content-type": "application/json" } });
			},
		});

		assert.equal(requestUrl, cloudflareTokenEndpoint);
		assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), {
			grant_type: "refresh_token",
			refresh_token: "old-refresh-token",
			client_id: "public-client-id",
		});
		assert.equal(refreshed.accessToken, "new-access-token");
		assert.equal(refreshed.refreshToken, "rotated-refresh-token");
		assert.equal(refreshed.expiresAt, "2026-08-19T09:00:00.000Z");
		assert.equal(refreshed.refreshedAt, "2026-08-19T07:00:00.000Z");
	});

	it("keeps the previous refresh token when Cloudflare does not rotate it", async () => {
		const refreshed = await refreshCloudflareOAuth(state, {
			now,
			fetchImpl: async () => new Response(JSON.stringify({ access_token: "new-access-token", expires_in: 3_600 }), { status: 200 }),
		});
		assert.equal(refreshed.refreshToken, "old-refresh-token");
	});

	it("requires a new browser login when no refresh grant is available", async () => {
		await assert.rejects(
			refreshCloudflareOAuth({ ...state, refreshToken: undefined }),
			/Run sickrat login again/,
		);
	});

	it("retries an authentication failure exactly once with the refreshed access token", async () => {
		const attempts: string[] = [];
		const result = await retryCloudflareAuthentication({
			accessToken: "expired-access-token",
			request: async (accessToken) => {
				attempts.push(accessToken);
				return { authenticated: accessToken === "fresh-access-token" };
			},
			isAuthenticationError: ({ authenticated }) => !authenticated,
			refresh: async () => "fresh-access-token",
		});
		assert.deepEqual(attempts, ["expired-access-token", "fresh-access-token"]);
		assert.equal(result.authenticated, true);
	});

	it("recognizes authentication errors without treating ordinary authorization failures as expiry", () => {
		assert.equal(isCloudflareAuthenticationError(401, undefined), true);
		assert.equal(isCloudflareAuthenticationError(400, [{ code: 10000, message: "Authentication error" }]), true);
		assert.equal(isCloudflareAuthenticationError(403, [{ code: 1001, message: "Permission denied" }]), false);
	});
});
