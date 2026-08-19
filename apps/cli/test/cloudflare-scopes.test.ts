import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudflareProvisioningScopes } from "../src/cloudflare-scopes.ts";

describe("Cloudflare provisioning scopes", () => {
	it("uses the configured R2 write scope alongside every existing provisioning scope", () => {
		assert.deepEqual(cloudflareProvisioningScopes, [
			"offline_access",
			"account-settings.read",
			"user-details.read",
			"d1.write",
			"workers-r2.write",
			"workers-scripts.read",
			"workers-scripts.write",
		]);
		assert.ok(!cloudflareProvisioningScopes.includes("r2.write"));
		assert.ok(!cloudflareProvisioningScopes.includes("workers-r2-storage.write"));
	});
});
