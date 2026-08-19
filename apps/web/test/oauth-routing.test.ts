import { describe, expect, it } from "vitest";
import { oauthConnectionNameFromSearch, oauthScopeRiskLabel } from "../src/oauth-routing";

describe("OAuth management routing", () => {
	it("prefills a canonical connection name from a CLI handoff", () => {
		expect(oauthConnectionNameFromSearch(new URLSearchParams("name=personal"))).toBe("personal");
		expect(oauthConnectionNameFromSearch(new URLSearchParams("name=Personal"))).toBeUndefined();
		expect(oauthConnectionNameFromSearch(new URLSearchParams("name=personal%2Fextra"))).toBeUndefined();
	});

	it("keeps scope risk labels aligned with CLI metadata", () => {
		expect(oauthScopeRiskLabel("high")).toBe("High risk");
		expect(oauthScopeRiskLabel("sensitive")).toBe("Sensitive");
	});
});
