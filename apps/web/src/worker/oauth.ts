export type OAuthScopeDefinition = {
	id: string;
	label: string;
	description: string;
	risk: "low" | "medium" | "high" | "sensitive";
};

export type OAuthProviderDefinition = {
	id: string;
	name: string;
	description: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	documentationUrl: string;
	defaultScopes: string[];
	identityScopes: string[];
	scopes: OAuthScopeDefinition[];
	supportsPkce: boolean;
	supportsRefreshToken: boolean;
	tokenEndpointAuthMethod: "none" | "client_secret_post";
	identity: {
		endpoint: string;
		subjectPath: string;
		labelPaths: string[];
	};
};

export type OAuthTokenResult = {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scopes: string[];
	tokenType: string;
};

const providers: OAuthProviderDefinition[] = [
	{
		id: "cloudflare",
		name: "Cloudflare",
		description: "Workers, D1, zones, and account APIs",
		authorizationEndpoint: "https://dash.cloudflare.com/oauth2/auth",
		tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
		documentationUrl: "https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/",
		defaultScopes: ["user-details.read", "account-settings.read", "workers-platform.read"],
		identityScopes: ["user-details.read"],
		scopes: [
			{ id: "user-details.read", label: "User details", description: "Identify the connected Cloudflare user.", risk: "low" },
			{ id: "account-settings.read", label: "Accounts", description: "List accessible Cloudflare accounts.", risk: "low" },
			{ id: "workers-platform.read", label: "Workers read", description: "List and inspect Worker scripts.", risk: "medium" },
			{ id: "workers-platform.write", label: "Workers write", description: "Create and update Worker scripts.", risk: "high" },
			{ id: "d1.read", label: "D1 read", description: "Read D1 databases and metadata.", risk: "medium" },
			{ id: "d1.write", label: "D1 write", description: "Create and modify D1 databases.", risk: "high" },
		],
		supportsPkce: true,
		supportsRefreshToken: true,
		tokenEndpointAuthMethod: "none",
		identity: {
			endpoint: "https://api.cloudflare.com/client/v4/user",
			subjectPath: "result.id",
			labelPaths: ["result.email", "result.username", "result.id"],
		},
	},
];

export function listOAuthProviders() {
	return providers;
}

export function getOAuthProvider(providerId: string) {
	return providers.find((provider) => provider.id === providerId) ?? null;
}

export function publicOAuthProvider(provider: OAuthProviderDefinition, clientId: string | null, origin: string) {
	return {
		id: provider.id,
		name: provider.name,
		description: provider.description,
		authorizationEndpoint: provider.authorizationEndpoint,
		documentationUrl: provider.documentationUrl,
		defaultScopes: provider.defaultScopes,
		identityScopes: provider.identityScopes,
		scopes: provider.scopes,
		supportsPkce: provider.supportsPkce,
		supportsRefreshToken: provider.supportsRefreshToken,
		clientId,
		configured: Boolean(clientId),
		redirectUri: `${origin}/oauth/callback/${provider.id}`,
	};
}

function normalizeScopes(value: unknown, fallback: string[]) {
	if (Array.isArray(value)) return value.filter((scope): scope is string => typeof scope === "string" && Boolean(scope));
	if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
	return fallback;
}

async function readTokenResponse(response: Response, fallbackScopes: string[]) {
	const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (!response.ok || typeof body?.access_token !== "string") {
		const description = typeof body?.error_description === "string" ? body.error_description : null;
		const error = typeof body?.error === "string" ? body.error : null;
		throw new Error(description ?? error ?? `OAuth token endpoint returned ${response.status}.`);
	}
	return {
		accessToken: body.access_token,
		refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
		expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
		scopes: normalizeScopes(body.scope, fallbackScopes),
		tokenType: typeof body.token_type === "string" ? body.token_type : "bearer",
	} satisfies OAuthTokenResult;
}

export async function exchangeOAuthAuthorizationCode(input: {
	provider: OAuthProviderDefinition;
	clientId: string;
	clientSecret?: string;
	code: string;
	codeVerifier: string;
	redirectUri: string;
	requestedScopes: string[];
}) {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: input.code,
		client_id: input.clientId,
		redirect_uri: input.redirectUri,
		code_verifier: input.codeVerifier,
	});
	if (input.provider.tokenEndpointAuthMethod === "client_secret_post" && input.clientSecret) body.set("client_secret", input.clientSecret);
	const response = await fetch(input.provider.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	return readTokenResponse(response, input.requestedScopes);
}

export async function refreshOAuthAccessToken(input: {
	provider: OAuthProviderDefinition;
	clientId: string;
	clientSecret?: string;
	refreshToken: string;
	grantedScopes: string[];
}) {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: input.refreshToken,
		client_id: input.clientId,
	});
	if (input.provider.tokenEndpointAuthMethod === "client_secret_post" && input.clientSecret) body.set("client_secret", input.clientSecret);
	const response = await fetch(input.provider.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	return readTokenResponse(response, input.grantedScopes);
}

function readPath(value: unknown, path: string) {
	let current = value;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[segment];
	}
	return typeof current === "string" || typeof current === "number" ? String(current) : null;
}

export async function inspectOAuthIdentity(provider: OAuthProviderDefinition, accessToken: string) {
	const response = await fetch(provider.identity.endpoint, {
		headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
	});
	const body = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) throw new Error(`OAuth identity endpoint returned ${response.status}.`);
	const subject = readPath(body, provider.identity.subjectPath);
	const label = provider.identity.labelPaths.map((path) => readPath(body, path)).find(Boolean) ?? subject;
	if (!subject || !label) throw new Error(`OAuth identity response for ${provider.name} was incomplete.`);
	return { subject, label };
}
