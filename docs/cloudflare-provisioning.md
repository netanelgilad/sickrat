# Cloudflare Provisioning

## Principle

All vault resources are created in the user's Cloudflare account after the user authorizes the CLI. Sickrat does not run a central backend that owns user vault data.

## Required Resources

- Worker script for API, PWA assets, and approval coordination
- D1 database for metadata and encrypted vault records
- private R2 bucket for the one current encrypted artifact of each browser session
- Durable Object namespace for pending approvals
- Worker asset binding for the PWA shell
- Worker vars/secrets for vault-specific VAPID push keys
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
3. The CLI creates or finds D1 and the private browser-session R2 bucket.
4. The CLI downloads and caches the matching Sickrat PWA/Worker release artifact.
5. The CLI uploads assets and deploys the Worker with D1, R2, Durable Object, assets, and VAPID bindings through the Cloudflare API.
6. The Worker upload metadata applies the Durable Object migration during deployment.
7. The CLI stores the vault endpoint and account metadata locally.
8. The user opens the vault URL on their phone, installs the PWA, then pairs CLI devices.

## OAuth Scopes

The login request includes `workers-r2-storage.write`, Cloudflare's current
OAuth scope ID for **Workers R2 Storage Write**. This permission must remain:
Sickrat creates the private browser-session bucket and reads and writes its
encrypted artifacts. Do not replace it with the obsolete `r2.write` scope or
remove R2 write access.

Cloudflare's OAuth API identifies this value as the scope object's `id`; verify
future changes with `GET /oauth/scopes`, rather than deriving an ID from its
display name. See [Cloudflare's OAuth client documentation](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
and [the OAuth scopes API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/).

## Idempotency

Provisioning should be repeatable. The app should record:

- project slug
- schema version
- Worker version
- resource ids
- migration status

If a resource exists, the app should verify it and reuse it rather than create duplicates.

## Open Questions

- Exact Cloudflare OAuth scopes required for Durable Object and secret configuration management beyond the existing login scope set.
- Whether future releases should embed the Worker/PWA artifact directly in the CLI binary. The current CLI downloads `sickrat-web-dist.tar.gz` from the matching GitHub Release and supports `SICKRAT_WEB_DIST` for maintainer workflows.
- Owner authentication for a newly deployed private vault should move away from Cloudflare OAuth redirect URIs because arbitrary `workers.dev` vault URLs are not practical OAuth callback targets for one shared client.
