# Opt-in grant reuse policy

`sickrat run --reuse-policy policy.json --env ITEM=synthetic/item-a -- node use-item.mjs`
requires an already approved, identifiable, encrypted local timed grant. It adds
a signed `POST /api/approvals/:id/reuse-status` check before injection. The worker
verifies the device signature, binds the signed command to that approval ID,
checks approval ownership, device revocation, approval state, and access expiry,
and returns only worker/device/request identity, state, and check timestamp.
It does not return ciphertext or plaintext or create/modify an approval.

Without this option the existing CLI behavior is unchanged. With it, missing
cache identity, expired access, unavailable/HTTP 500 status, revoked state,
identity mismatch, stale evidence, or uncovered typed resources stop the command
before injection/launch. No replacement approval is automatically requested.
Older cache entries lack `requestId` and are rejected; newly received timed grants
record it. A normally approved new grant is still required before opt-in reuse.

Example nonsecret policy (arbitrary values, disabled):

```json
{
  "enabled": false,
  "workerUrl": "https://synthetic.invalid",
  "deviceId": "synthetic-device",
  "requestId": "synthetic-request",
  "resources": [{ "type": "secret", "ref": "synthetic/item-a", "env": "ITEM" }],
  "approvalOpensAt": "2026-10-13T09:00:00+03:00",
  "approvalClosesAt": "2026-10-13T09:10:00+03:00",
  "accessExpiresAt": "2026-10-13T09:30:00+03:00",
  "maxStatusAgeMs": 5000
}
```

The example uses a dated Asia/Jerusalem window; another date requires resolving
its actual offset. The validator consumes absolute timestamps, not schedules.
Approval is in `[open, close)`; reuse ends at the earlier of policy expiry and
grant expiry. Status is accepted only for the exact approval/device/worker and
within the configured age, with no future timestamp. Resource type, identifiers,
environment binding, OAuth connection and scopes match exactly; a narrower
resource list is allowed but scope sets must match for each typed token resource.
Neither the policy nor the status response extends access or mints credentials.

The policy is a local restriction, not an authenticated permission issuance
format, an operation allowlist, or a replacement for existing phone approval.
Sickrat alone injects approved values into the child environment; the metadata
file must never contain plaintext values. Tests use temporary homes, dummy data,
generated test signing keys, and loopback HTTP only. The worker integration test
uses isolated Cloudflare test bindings, never a deployed vault.

Revocation currently means the existing device revocation lifecycle (or an
inactive approval). There is no new individual grant revocation API. A signed
check is current at response time; revocation or expiry after launch does not
terminate or retract credentials from an already running child. Do not claim
continuous revocation enforcement, process cancellation, or persistent scheduled
permission from this change. HTTP 500 is a status/control-plane failure, not a
credential denial or a downstream process outcome.

Interface parity: this CLI-only option restricts the CLI's private encrypted
cache, which the PWA cannot inspect/decrypt. PWA device inspection/revocation
remains the existing management interface and is honored by the new check.
No new management lifecycle is exposed only on one interface; no encrypted
secret/OAuth reauthorization flow changes. Upgrading the CLI does not update a
user-owned vault: the new endpoint requires its matching worker artifact through
the existing owner-controlled vault-update flow. An old worker fails closed.

