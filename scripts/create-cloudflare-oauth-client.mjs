#!/usr/bin/env node

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.argv[2];
const token = process.env.CLOUDFLARE_API_TOKEN;
const origin = process.env.SICKRAT_ORIGIN ?? "https://sickrat.dev";
const clientName = process.env.SICKRAT_OAUTH_CLIENT_NAME ?? "Sickrat";

if (!accountId) {
	console.error("Set CLOUDFLARE_ACCOUNT_ID or pass the account id as the first argument.");
	process.exit(1);
}

if (!token) {
	console.error("Set CLOUDFLARE_API_TOKEN with the OAuth Client Write permission.");
	process.exit(1);
}

const baseUrl = "https://api.cloudflare.com/client/v4";
const redirectUri = `${origin}/cf/callback`;
const clientUri = origin;

const desired = {
	client_name: clientName,
	grant_types: ["authorization_code", "refresh_token"],
	redirect_uris: [redirectUri],
	response_types: ["code"],
	scopes: [
		"account-settings.read",
		"user-details.read",
		"d1.write",
		"secrets-store.write",
		"workers-scripts.read",
		"workers-scripts.write",
	],
	token_endpoint_auth_method: "none",
	allowed_cors_origins: [origin],
	client_uri: clientUri,
	post_logout_redirect_uris: [origin],
};

async function cf(path, init = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			...(init.headers ?? {}),
		},
	});
	const body = await response.json();
	if (!response.ok || !body.success) {
		const message = body.errors?.map((error) => error.message).join("; ") || `Cloudflare API returned ${response.status}`;
		throw new Error(message);
	}
	return body.result;
}

const clients = await cf(`/accounts/${accountId}/oauth_clients?per_page=100`);
const existing = clients.find((client) => client.client_name === clientName || client.redirect_uris?.includes(redirectUri));

const result = existing
	? await cf(`/accounts/${accountId}/oauth_clients/${existing.client_id}`, {
			method: "PATCH",
			body: JSON.stringify(desired),
		})
	: await cf(`/accounts/${accountId}/oauth_clients`, {
			method: "POST",
			body: JSON.stringify(desired),
		});

console.log(
	JSON.stringify(
		{
			created: !existing,
			clientId: result.client_id,
			clientName: result.client_name,
			visibility: result.visibility,
			redirectUris: result.redirect_uris,
			scopes: result.scopes,
			tokenEndpointAuthMethod: result.token_endpoint_auth_method,
			clientUriVerification: result.client_uri_verification,
			next: `Set CF_OAUTH_CLIENT_ID=${result.client_id} on the Worker, then deploy.`,
		},
		null,
		2,
	),
);
