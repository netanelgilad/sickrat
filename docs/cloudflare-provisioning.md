# Cloudflare Provisioning

## Principle

All vault resources are created in the user's Cloudflare account after the user authorizes the CLI. Sickrat does not run a central backend that owns user vault data.

## Required Resources

- Worker script for API, PWA assets, and approval coordination
- D1 database for metadata and encrypted vault records
- Durable Object namespace for pending approvals
- Worker asset binding for the PWA shell
- Worker vars/secrets for vault-specific VAPID push keys
- Optional R2 bucket for large encrypted payloads
- Optional KV namespace for deployment metadata and non-sensitive config

## Worker Secrets

Worker secrets/vars are only for operational configuration, for example:

- VAPID public key as a Worker var and VAPID private key as a Worker secret
- allowed app origins
- provisioning version markers

They are not used as the vault storage mechanism.

Cloudflare Secrets Store is not required for the current vault model. The PWA encrypts secret values locally and the Worker stores ciphertext in D1. Add Secrets Store later only if the Worker needs to hold its own operational secrets, or if the product deliberately chooses a Cloudflare-native secret storage model for a specific feature.

## Provisioning Flow

1. `sickrat login` performs Cloudflare OAuth with PKCE and stores the owner control-plane token locally.
2. `sickrat vault create` selects a Cloudflare account.
3. The CLI creates or finds D1.
4. The CLI downloads and caches the matching Sickrat PWA/Worker release artifact.
5. The CLI uploads assets and deploys the Worker with D1, Durable Object, assets, and VAPID bindings through the Cloudflare API.
6. The Worker upload metadata applies the Durable Object migration during deployment.
7. The CLI stores the vault endpoint and account metadata locally.
8. The user opens the vault URL on their phone, installs the PWA, then pairs CLI devices.

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
- Whether future releases should embed the Worker/PWA artifact directly in the CLI binary. The current CLI downloads `sickrat-web-dist.tar.gz` from the matching GitHub Release and supports `SICKRAT_WEB_DIST` for maintainer workflows.
- Owner authentication for a newly deployed private vault should move away from Cloudflare OAuth redirect URIs because arbitrary `workers.dev` vault URLs are not practical OAuth callback targets for one shared client.
