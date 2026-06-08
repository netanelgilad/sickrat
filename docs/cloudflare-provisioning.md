# Cloudflare Provisioning

## Principle

All resources are created in the user's Cloudflare account after the user authorizes the app. Sickrat does not run a central backend that owns user vault data.

## Required Resources

- Worker script for API and approval coordination
- D1 database for metadata and encrypted vault records
- Durable Object namespace for pending approvals
- Optional R2 bucket for large encrypted payloads
- Optional KV namespace for deployment metadata and non-sensitive config

## Worker Secrets

Worker secrets are only for operational configuration, for example:

- Expo push access token if needed
- allowed app origins
- provisioning version markers

They are not used as the vault storage mechanism.

## Provisioning Flow

1. Mobile app initiates Login with Cloudflare.
2. User selects their Cloudflare account.
3. App requests the permissions needed to create and manage the project's resources.
4. App creates or updates the Worker deployment.
5. App creates D1, Durable Object namespace, and optional R2/KV.
6. App applies migrations.
7. App stores the Worker endpoint and account metadata locally.
8. App prompts the user to pair their first CLI device.

## Idempotency

Provisioning should be repeatable. The app should record:

- project slug
- schema version
- Worker version
- resource ids
- migration status

If a resource exists, the app should verify it and reuse it rather than create duplicates.

## Open Questions

- Exact Cloudflare OAuth scopes required for Worker, D1, Durable Object, R2, and secret configuration management.
- Whether the first release should provision from the mobile app directly or hand off to CLI for account setup.
- Whether the Worker code should be deployed as source, bundled artifact, or remote template.
