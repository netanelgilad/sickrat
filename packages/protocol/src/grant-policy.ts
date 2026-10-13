import type { ApprovalResourceRequest, GrantPayload } from "./index.ts";

/** Nonsecret metadata only. A trusted adapter must authenticate all supplied evidence. */
export type GrantReusePolicy = {
	enabled: boolean;
	workerUrl: string;
	deviceId: string;
	requestId: string;
	resources: ApprovalResourceRequest[];
	approvalOpensAt: string;
	approvalClosesAt: string;
	accessExpiresAt: string;
	maxStatusAgeMs: number;
};

export type GrantReuseStatus = {
	workerUrl: string;
	deviceId: string;
	requestId: string;
	state: "active" | "revoked";
	checkedAt: string;
};

export type GrantReuseDecision =
	| "allowed" | "disabled" | "identity-mismatch" | "invalid-time"
	| "approval-expired" | "access-expired" | "status-unavailable"
	| "status-mismatch" | "status-stale" | "revoked" | "resource-mismatch";

// Explicit tuples avoid delimiter collisions and keep types/bindings distinct.
function resourceKey(resource: ApprovalResourceRequest): string | null {
	if (resource.type === "secret" && resource.ref) return JSON.stringify(["secret", resource.ref, resource.env ?? null]);
	if (resource.type === "oauth_token" && resource.providerId && resource.scopes.length > 0 && resource.scopes.every(scope => typeof scope === "string" && scope.length > 0)) {
		if (new Set(resource.scopes).size !== resource.scopes.length) return null;
		return JSON.stringify(["oauth_token", resource.providerId, resource.connectionName ?? null, resource.env ?? null, [...resource.scopes].sort()]);
	}
	// Existing browser-session transactions are single-use, not reusable timed grants.
	return null;
}

/** Preparation-only primitive: no I/O, plaintext, cache mutation, or automatic renewal. */
export function validateGrantReuse(input: {
	policy: GrantReusePolicy;
	workerUrl: string;
	deviceId: string;
	requestId: string;
	resources: ApprovalResourceRequest[];
	grant: Pick<GrantPayload, "approvedAt" | "accessExpiresAt">;
	status?: GrantReuseStatus;
	now: number;
}): GrantReuseDecision {
	const { policy, grant, status, now } = input;
	if (policy.enabled !== true) return "disabled";
	if (!policy.workerUrl || !policy.deviceId || !policy.requestId || policy.workerUrl !== input.workerUrl || policy.deviceId !== input.deviceId || policy.requestId !== input.requestId) return "identity-mismatch";
	const open = Date.parse(policy.approvalOpensAt);
	const close = Date.parse(policy.approvalClosesAt);
	const approved = Date.parse(grant.approvedAt);
	const policyExpiry = Date.parse(policy.accessExpiresAt);
	const grantExpiry = Date.parse(grant.accessExpiresAt ?? "");
	if (![now, open, close, approved, policyExpiry, grantExpiry, policy.maxStatusAgeMs].every(Number.isFinite) || open >= close || close > policyExpiry || grantExpiry <= approved || policy.maxStatusAgeMs < 0) return "invalid-time";
	if (approved < open || approved >= close) return "approval-expired";
	if (now < approved || now >= Math.min(policyExpiry, grantExpiry)) return "access-expired";
	if (!status) return "status-unavailable";
	if (status.workerUrl !== policy.workerUrl || status.deviceId !== policy.deviceId || status.requestId !== policy.requestId) return "status-mismatch";
	if (status.state === "revoked") return "revoked";
	if (status.state !== "active") return "status-unavailable";
	const checked = Date.parse(status.checkedAt);
	if (!Number.isFinite(checked) || checked < approved || checked > now || now - checked > policy.maxStatusAgeMs) return "status-stale";
	const approvedKeys = policy.resources.map(resourceKey);
	const requestedKeys = input.resources.map(resourceKey);
	if (!approvedKeys.length || !requestedKeys.length || approvedKeys.includes(null) || requestedKeys.includes(null) || new Set(approvedKeys).size !== approvedKeys.length || new Set(requestedKeys).size !== requestedKeys.length || requestedKeys.some(key => !approvedKeys.includes(key))) return "resource-mismatch";
	return "allowed";
}
