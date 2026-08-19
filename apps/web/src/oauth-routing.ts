import { isOAuthReferenceSegment, type OAuthScopeRisk } from "@sickrat/protocol";

export function oauthConnectionNameFromSearch(searchParams: URLSearchParams) {
	const value = searchParams.get("name") ?? "";
	return isOAuthReferenceSegment(value) ? value : undefined;
}

export function oauthScopeRiskLabel(risk: OAuthScopeRisk) {
	return risk === "sensitive" ? "Sensitive" : `${risk.charAt(0).toUpperCase()}${risk.slice(1)} risk`;
}
