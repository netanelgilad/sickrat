import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateGrantReuse, type GrantReusePolicy, type GrantReuseStatus, type ApprovalResourceRequest } from "../src/index.ts";

const resources: ApprovalResourceRequest[] = [{ type: "secret", ref: "synthetic/item-a", env: "ITEM_A" }, { type: "secret", ref: "synthetic/item-b" }];
const open = "2026-10-13T09:00:00+03:00";
const close = "2026-10-13T09:10:00+03:00";
const expiry = "2026-10-13T09:30:00+03:00";
const now = Date.parse("2026-10-13T06:11:00Z");
const policy: GrantReusePolicy = { enabled: true, workerUrl: "https://synthetic.invalid", deviceId: "synthetic-device", requestId: "synthetic-request", resources, approvalOpensAt: open, approvalClosesAt: close, accessExpiresAt: expiry, maxStatusAgeMs: 1000 };
const status: GrantReuseStatus = { workerUrl: policy.workerUrl, deviceId: policy.deviceId, requestId: policy.requestId, state: "active", checkedAt: new Date(now).toISOString() };
const base = { policy, workerUrl: policy.workerUrl, deviceId: policy.deviceId, requestId: policy.requestId, resources: [resources[0]], grant: { approvedAt: open, accessExpiresAt: expiry }, status, now };

describe("generic grant reuse policy (synthetic metadata only)", () => {
	it("defaults disabled and binds exact requester, origin and approval identity", () => {
		assert.equal(validateGrantReuse(base), "allowed");
		assert.equal(validateGrantReuse({ ...base, policy: { ...policy, enabled: false } }), "disabled");
		for (const field of ["workerUrl", "deviceId", "requestId"] as const) {
			assert.equal(validateGrantReuse({ ...base, [field]: "another-identity" }), "identity-mismatch");
			assert.equal(validateGrantReuse({ ...base, status: { ...status, [field]: "another-identity" } }), "status-mismatch");
		}
	});
	it("requires fresh authoritative status and rejects revoked or unavailable evidence", () => {
		assert.equal(validateGrantReuse({ ...base, status: undefined }), "status-unavailable");
		assert.equal(validateGrantReuse({ ...base, status: { ...status, state: "revoked" } }), "revoked");
		for (const checkedAt of ["invalid", new Date(now + 1).toISOString(), new Date(now - 1001).toISOString()]) {
			assert.equal(validateGrantReuse({ ...base, status: { ...status, checkedAt } }), "status-stale");
		}
		assert.equal(validateGrantReuse({ ...base, status: { ...status, checkedAt: new Date(now - 1000).toISOString() } }), "allowed");
	});
	it("separates a dated approval window from explicit access expiry", () => {
		assert.equal(Date.parse(open), Date.parse("2026-10-13T06:00:00Z"));
		assert.equal(validateGrantReuse({ ...base, grant: { ...base.grant, approvedAt: close } }), "approval-expired");
		assert.equal(validateGrantReuse({ ...base, now: Date.parse(expiry) }), "access-expired");
		assert.equal(validateGrantReuse({ ...base, grant: { ...base.grant, accessExpiresAt: new Date(now).toISOString() } }), "access-expired");
		assert.equal(validateGrantReuse({ ...base, grant: { approvedAt: open } }), "invalid-time");
		assert.equal(validateGrantReuse({ ...base, policy: { ...policy, approvalClosesAt: open } }), "invalid-time");
		assert.equal(validateGrantReuse({ ...base, now: Number.NaN }), "invalid-time");
	});
	it("matches typed resources exactly and rejects aliases, duplicates and single-use transactions", () => {
		for (const requested of [[], [resources[0], resources[0]], [{ type: "secret", ref: "synthetic/item-a-extra", env: "ITEM_A" }], [{ type: "secret", ref: "synthetic/item-a", env: "OTHER" }], [{ type: "browser_session", resourceRef: "synthetic/item-a", access: "restore" }]] as ApprovalResourceRequest[][]) {
			assert.equal(validateGrantReuse({ ...base, resources: requested }), "resource-mismatch");
		}
		const typed: ApprovalResourceRequest = { type: "oauth_token", providerId: "synthetic-service", connectionName: "synthetic-connection", scopes: ["write", "read"], env: "TOKEN" };
		const typedBase = { ...base, policy: { ...policy, resources: [typed] }, resources: [{ ...typed, scopes: ["read", "write"] }] };
		assert.equal(validateGrantReuse(typedBase), "allowed");
		assert.equal(validateGrantReuse({ ...typedBase, resources: [{ ...typed, scopes: ["read"] }] }), "resource-mismatch");
	});
});
