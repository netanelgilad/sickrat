import { describe, expect, it } from "vitest";
import { describeOAuthApprovalBlocker, matchingOAuthConnection } from "../src/oauth-approval";

const request = {
	providerId: "cloudflare",
	connectionName: "default",
	scopes: ["d1.write", "workers-r2-storage.write"],
};

describe("OAuth approval diagnostics", () => {
	it("explains exactly which scope prevents approval", () => {
		const connections = [{
			providerId: "cloudflare",
			connectionName: "default",
			grantedScopes: ["d1.write"],
			revokedAt: null,
		}];

		expect(matchingOAuthConnection(request, connections)).toBeUndefined();
		expect(describeOAuthApprovalBlocker(request, connections)).toBe(
			"cloudflare/default is missing required OAuth scopes: workers-r2-storage.write. Reauthorize the connection and confirm the OAuth client permits these exact scope IDs.",
		);
	});

	it("does not block a connection that covers every requested scope", () => {
		const connections = [{
			providerId: "cloudflare",
			connectionName: "default",
			grantedScopes: ["d1.write", "workers-r2-storage.write", "user-details.read"],
			revokedAt: null,
		}];

		expect(matchingOAuthConnection(request, connections)).toBe(connections[0]);
		expect(describeOAuthApprovalBlocker(request, connections)).toBeNull();
	});
});
