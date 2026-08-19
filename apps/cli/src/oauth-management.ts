import { isOAuthReferenceSegment, type OAuthProvider } from "@sickrat/protocol";

export type ProviderCommand =
	| { action: "list"; json: boolean }
	| { action: "show"; providerId: string; json: boolean }
	| { action: "configure"; providerId: string; clientId: string; json: boolean };

export function parseProviderId(value: string | undefined) {
	if (!value || !isOAuthReferenceSegment(value)) {
		throw new Error("Provider IDs must use lowercase letters, numbers, and hyphens.");
	}
	return value;
}

export function parseConnectionReference(value: string | undefined) {
	if (!value) throw new Error("A connection reference in the form <provider>/<name> is required.");
	const [providerId, connectionName, ...extra] = value.split("/");
	if (extra.length || !isOAuthReferenceSegment(providerId) || !isOAuthReferenceSegment(connectionName)) {
		throw new Error(`Invalid connection reference: ${value}. Use <provider>/<name>, for example cloudflare/work.`);
	}
	return { providerId, connectionName };
}

export function validateOAuthClientId(value: string | undefined) {
	if (!value || !value.trim() || value.trim() !== value || value.length > 512) {
		throw new Error("A client ID without leading or trailing spaces is required.");
	}
	return value;
}

export function parseProviderCommand(args: string[]): ProviderCommand {
	const [subcommand] = args;
	if (subcommand === "list") {
		const unsupported = args.slice(1).filter((arg) => arg !== "--json");
		if (unsupported.length) throw new Error(`Unknown sickrat provider list option: ${unsupported[0]}`);
		return { action: "list", json: args.includes("--json") };
	}
	if (subcommand === "show") {
		const providerId = parseProviderId(args[1]);
		const unsupported = args.slice(2).filter((arg) => arg !== "--json");
		if (unsupported.length) throw new Error(`Unknown sickrat provider show option: ${unsupported[0]}`);
		return { action: "show", providerId, json: args.includes("--json") };
	}
	if (subcommand === "configure") {
		const providerId = parseProviderId(args[1]);
		let clientId: string | undefined;
		let json = false;
		for (let index = 2; index < args.length; index += 1) {
			const arg = args[index];
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--client-id") {
				if (clientId !== undefined) throw new Error("--client-id may only be provided once.");
				const value = args[index + 1];
				if (!value || value.startsWith("--")) throw new Error("--client-id requires a value.");
				clientId = value;
				index += 1;
				continue;
			}
			throw new Error(`Unknown sickrat provider configure option: ${arg}`);
		}
		return { action: "configure", providerId, clientId: validateOAuthClientId(clientId), json };
	}
	throw new Error(`Unknown sickrat provider command: ${subcommand ?? ""}`);
}

export function providerSetupUrl(workerUrl: string, providerId: string, connectionName: string) {
	const url = new URL(`/connections/providers/${encodeURIComponent(providerId)}`, workerUrl);
	url.searchParams.set("name", connectionName);
	return url.toString();
}

export function providerListLine(provider: OAuthProvider) {
	return `${provider.id}\t${provider.name}\t${provider.configured ? "ready" : "setup needed"}\t${provider.redirectUri}`;
}

export function formatOAuthProvider(provider: OAuthProvider) {
	const lines = [
		`ID: ${provider.id}`,
		`Name: ${provider.name}`,
		`Description: ${provider.description}`,
		`Status: ${provider.configured ? "ready" : "setup needed"}`,
		`OAuth client ID: ${provider.clientId ?? "not configured"}`,
		`Callback URL: ${provider.redirectUri}`,
		`Authorization endpoint: ${provider.authorizationEndpoint}`,
		`Documentation: ${provider.documentationUrl}`,
		`PKCE: ${provider.supportsPkce ? "supported" : "not supported"}`,
		`Persistent access: ${provider.supportsRefreshToken ? "supported" : "not supported"}`,
		`Identity scopes: ${provider.identityScopes.join(", ")}`,
		`Connection scopes: ${provider.connectionScopes.join(", ")}`,
		"Scopes:",
	];
	for (const scope of provider.scopes) lines.push(`  ${scope.id}\t${scope.risk}\t${scope.label}: ${scope.description}`);
	return lines.join("\n");
}
