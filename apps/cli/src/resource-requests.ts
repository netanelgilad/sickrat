import type { ApprovalResourceRequest } from "@sickrat/protocol";

export type ParsedEnvResource =
	| { type: "secret"; ref: string }
	| { type: "oauth_token"; providerId: string; scopes: string[] };

const providerIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rejectNonCanonicalUrl(url: URL, value: string) {
	if (url.protocol !== "sickrat:" || url.username || url.password || url.port || url.hash) {
		throw new Error(`Invalid Sickrat reference URI: ${value}`);
	}
}

export function parseSickratUri(value: string): ParsedEnvResource | null {
	if (!value.startsWith("sickrat://")) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid Sickrat reference URI: ${value}`);
	}
	rejectNonCanonicalUrl(url, value);

	if (url.hostname === "oauth") {
		const providerId = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ""));
		if (!providerIdPattern.test(providerId)) throw new Error(`Invalid Sickrat OAuth provider URI: ${value}`);
		const unsupportedParams = [...url.searchParams.keys()].filter((key) => key !== "scope");
		if (unsupportedParams.length > 0) throw new Error(`Unsupported Sickrat OAuth parameter: ${unsupportedParams[0]}`);
		const scopes = url.searchParams.getAll("scope");
		if (scopes.length === 0 || scopes.length > 20 || scopes.some((scope) => !scope || scope.trim() !== scope || scope.length > 256)) {
			throw new Error(`At least one OAuth scope is required: ${value}`);
		}
		return { type: "oauth_token", providerId, scopes: [...new Set(scopes)] };
	}
	if (url.search) throw new Error(`Secret reference URIs do not support query parameters: ${value}`);

	const ref = `${url.hostname}${url.pathname}`.replace(/^\/+|\/+$/g, "");
	if (!ref) throw new Error(`Invalid Sickrat reference URI: ${value}`);
	return { type: "secret", ref: decodeURIComponent(ref) };
}

export function resourceRequestForEnv(resource: ParsedEnvResource, env: string): ApprovalResourceRequest {
	if (!envNamePattern.test(env)) throw new Error(`Invalid environment variable name: ${env}`);
	return resource.type === "secret"
		? { type: "secret", ref: resource.ref, env }
		: { type: "oauth_token", providerId: resource.providerId, scopes: resource.scopes, env };
}
