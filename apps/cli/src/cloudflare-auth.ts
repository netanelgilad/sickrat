export type CloudflareOAuthState = {
	clientId: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt?: string;
	scope?: string;
	tokenType: string;
	loggedInAt: string;
	refreshedAt?: string;
};

type CloudflareTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
};

export const cloudflareRefreshSkewMs = 60_000;
export const cloudflareTokenEndpoint = "https://dash.cloudflare.com/oauth2/token";

export function shouldRefreshCloudflareOAuth(state: CloudflareOAuthState, now = Date.now()) {
	if (!state.expiresAt) return false;
	const expiresAt = Date.parse(state.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= now + cloudflareRefreshSkewMs;
}

export async function refreshCloudflareOAuth(
	state: CloudflareOAuthState,
	options: { fetchImpl?: typeof fetch; now?: number } = {},
) {
	if (!state.refreshToken) {
		throw new Error("Cloudflare login cannot be refreshed. Run sickrat login again.");
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now();
	const response = await fetchImpl(cloudflareTokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: state.refreshToken,
			client_id: state.clientId,
		}),
	});
	const token = (await response.json().catch(() => null)) as CloudflareTokenResponse | null;
	if (!response.ok || typeof token?.access_token !== "string" || !token.access_token) {
		const reason = token?.error_description ?? token?.error;
		throw new Error(`Cloudflare login refresh failed${reason ? `: ${reason}` : ` with HTTP ${response.status}`}. Run sickrat login again.`);
	}
	const expiresIn = typeof token.expires_in === "number" && Number.isFinite(token.expires_in) && token.expires_in > 0
		? token.expires_in
		: undefined;
	return {
		...state,
		accessToken: token.access_token,
		refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : state.refreshToken,
		expiresAt: expiresIn ? new Date(now + expiresIn * 1000).toISOString() : undefined,
		scope: typeof token.scope === "string" ? token.scope : state.scope,
		tokenType: typeof token.token_type === "string" && token.token_type ? token.token_type : state.tokenType,
		refreshedAt: new Date(now).toISOString(),
	} satisfies CloudflareOAuthState;
}

export function isCloudflareAuthenticationError(
	status: number,
	errors: Array<{ code?: number; message?: string }> | undefined,
) {
	if (status === 401) return true;
	return Boolean(errors?.some((error) =>
		[10000, 9109].includes(error.code ?? -1) ||
		/authentication error|invalid (?:access )?token|expired (?:access )?token/i.test(error.message ?? ""),
	));
}

export async function retryCloudflareAuthentication<T>(input: {
	accessToken: string;
	request: (accessToken: string) => Promise<T>;
	isAuthenticationError: (result: T) => boolean;
	refresh: (failedAccessToken: string) => Promise<string>;
}) {
	const first = await input.request(input.accessToken);
	if (!input.isAuthenticationError(first)) return first;
	const refreshedAccessToken = await input.refresh(input.accessToken);
	return input.request(refreshedAccessToken);
}
