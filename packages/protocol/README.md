# Protocol

Shared schema and cryptographic envelope definitions for the mobile app, Worker, and CLI.

`validateGrantReuse` validates nonsecret reuse metadata: exact worker/device/request
identity, typed manifest coverage, dated approval interval, explicit access expiry,
and current revocation status with a caller-defined freshness bound. The gate is
disabled unless explicitly true. It never reads credentials, requests approval,
injects values, persists grants, or resolves a recurring schedule. Browser-session
transactions remain single-use and are rejected by this reusable-grant validator.

The caller must authenticate the status source and supply valid typed metadata.
Local policy files can only restrict an existing approved grant, never authorize
additional resources. See [runtime contract](../../../docs/grant-reuse-policy.md).
