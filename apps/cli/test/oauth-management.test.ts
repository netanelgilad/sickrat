import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OAuthProvider } from "@sickrat/protocol";
import {
	formatOAuthProvider,
	parseConnectionReference,
	parseProviderCommand,
	providerListLine,
	providerSetupUrl,
} from "../src/oauth-management.ts";

const xProvider: OAuthProvider = {
	id: "x",
	name: "X",
	description: "Account identity, post research, and approved publishing",
	authorizationEndpoint: "https://x.com/i/oauth2/authorize",
	documentationUrl: "https://docs.x.com/oauth",
	identityScopes: ["users.read", "tweet.read"],
	connectionScopes: ["offline.access"],
	scopes: [
		{ id: "users.read", label: "Users read", description: "Read profiles.", risk: "low" },
		{ id: "tweet.write", label: "Publish posts", description: "Publish approved posts.", risk: "sensitive" },
	],
	supportsPkce: true,
	supportsRefreshToken: true,
	clientId: "x-client-id",
	configured: true,
	redirectUri: "https://vault.example/oauth/callback/x",
};

describe("OAuth provider CLI management", () => {
	it("parses list, show, and configure commands", () => {
		assert.deepEqual(parseProviderCommand(["list", "--json"]), { action: "list", json: true });
		assert.deepEqual(parseProviderCommand(["show", "x"]), { action: "show", providerId: "x", json: false });
		assert.deepEqual(parseProviderCommand(["configure", "x", "--client-id", "public-id", "--json"]), {
			action: "configure",
			providerId: "x",
			clientId: "public-id",
			json: true,
		});
	});

	it("rejects non-canonical provider configuration", () => {
		assert.throws(() => parseProviderCommand(["show", "X"]), /lowercase letters/);
		assert.throws(() => parseProviderCommand(["configure", "x", "--client-id", " public-id"]), /without leading or trailing spaces/);
		assert.throws(() => parseProviderCommand(["configure", "x", "--client-secret", "secret"]), /Unknown sickrat provider configure option/);
		assert.throws(() => parseProviderCommand(["configure", "x", "--client-id"]), /requires a value/);
	});

	it("builds a named secure PWA connect handoff", () => {
		assert.deepEqual(parseConnectionReference("x/personal"), { providerId: "x", connectionName: "personal" });
		assert.equal(providerSetupUrl("https://vault.example", "x", "personal"), "https://vault.example/connections/providers/x?name=personal");
		assert.throws(() => parseConnectionReference("x/Personal"), /Invalid connection reference/);
	});

	it("prints the same provider setup and risk metadata shown by the PWA", () => {
		assert.equal(providerListLine(xProvider), "x\tX\tready\thttps://vault.example/oauth/callback/x");
		const output = formatOAuthProvider(xProvider);
		assert.match(output, /OAuth client ID: x-client-id/);
		assert.match(output, /Callback URL: https:\/\/vault\.example\/oauth\/callback\/x/);
		assert.match(output, /tweet\.write\tsensitive\tPublish posts/);
	});
});
