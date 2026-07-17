# OAuth Gateway

Sickrat supports agent-requested access to OAuth integrations with the same approval and passkey protection model used for secret refs. Cloudflare is the first provider implementation.

The product goal is not to become a hosted connector platform. Each vault remains user-owned. Provider refresh tokens are stored as encrypted vault records in the user's D1 database, unlocked from the PWA with the vault key, and released to paired machines only as short-lived access-token grants after explicit approval.

## Product Shape

Agents can request either ordinary secret refs or OAuth access tokens in one approval request.

Examples:

```sh
sickrat run \
  --env GITHUB_TOKEN='sickrat://oauth/github?scope=repo&scope=read:user' \
  --message "Inspect repository issues and open a draft PR." \
  -- gh issue list
```

`sickrat run` remains the normal interface when a child process needs the token in its environment. Env files can mix ordinary values, vault secrets, and OAuth token requests:

```env
OPENAI_API_KEY=sickrat://default/openai/api-key
GITHUB_TOKEN=sickrat://oauth/github?scope=repo&scope=read:user
SLACK_TOKEN=sickrat://oauth/slack?scope=chat:write
SHOW_BROWSER=true
```

## Key Concepts

### Provider Catalog

The PWA should show a catalog of supported providers:

- GitHub
- Cloudflare
- Slack
- Twitter/X
- Google
- Linear
- Notion
- generic OAuth 2.0 / OIDC

Each provider definition should include:

- provider id and display name
- authorization endpoint
- token endpoint
- revocation endpoint, if supported
- default scopes
- known scope descriptions
- whether PKCE is supported
- whether refresh tokens are supported
- whether token refresh requires a client secret
- account identity endpoint, if available
- OAuth app setup requirements

The catalog is non-sensitive config shipped with the Worker/PWA. A later version can add user-defined providers from the PWA.

### Connections

A connection is an authenticated provider account stored in the vault.

```ts
type OAuthConnection = {
  id: string;
  providerId: string;
  accountLabel: string;
  accountSubject?: string;
  accountHandle?: string;
  grantedScopes: string[];
  tokenType: "bearer" | string;
  accessTokenExpiresAt?: string;
  refreshTokenCiphertext: string;
  refreshTokenIv: string;
  refreshTokenSalt: string;
  refreshTokenKdf: string;
  providerMetadataJson?: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};
```

Refresh tokens are encrypted like secret values. Access tokens should not be stored by default. If cached later, cache them encrypted with a short expiry and treat them as grants, not durable vault records.

### OAuth Grant Requests

Approval requests should grow from `secretRefs` into typed requested resources while keeping `secretRefs` for compatibility.

The CLI detects OAuth requests from the existing `sickrat://` URI scheme. The reserved `oauth` namespace identifies the provider and requested scopes:

```text
sickrat://oauth/github?scope=repo&scope=read:user
sickrat://oauth/cloudflare?scope=workers-platform.write&scope=d1.write
sickrat://oauth/slack?scope=chat:write
```

These URIs are request descriptors. They must never contain access tokens, refresh tokens, client secrets, or other credential material.

## Current Implementation

The complete Cloudflare flow is implemented:

- The CLI parses canonical `sickrat://oauth/...` descriptors from `--env` and env files.
- Typed resources are covered by the paired-device signature and persisted with the approval.
- The PWA manages provider client configuration and encrypted account connections.
- Authorization uses authorization code with PKCE; refresh is proxied through the user-owned Worker.
- Refresh tokens are encrypted under the passkey-protected vault key before D1 storage.
- Approval shows the requested scopes and the connection's effective scope set.
- The PWA seals access tokens to the requesting CLI's ephemeral public key.
- The CLI validates provider, scopes, and expiry before environment injection.
- Timed local grants cache the encrypted access-token grant only until the earlier of approval expiry or provider-token expiry.

Adding another standards-based provider is primarily a catalog entry in `apps/web/src/worker/oauth.ts`: endpoints, scope descriptions, identity response paths, and token endpoint authentication mode. The request, connection, refresh, approval, grant, and CLI injection paths are provider-independent.

```ts
type ApprovalResourceRequest =
  | {
      type: "secret";
      ref: string;
      env?: string;
    }
  | {
      type: "oauth_token";
      providerId: string;
      scopes: string[];
      env?: string;
    };
```

For compatibility, the Worker can store both:

- `secret_refs TEXT`, the current JSON array for old CLIs.
- `resource_requests TEXT`, a JSON array for typed resources.

The encrypted grant payload should also become typed:

```ts
type GrantPayload = {
  secrets?: Record<string, string>;
  oauthTokens?: Record<string, {
    providerId: string;
    connectionId: string;
    accessToken: string;
    tokenType: string;
    scopes: string[];
    expiresAt?: string;
  }>;
  approvedAt: string;
  accessExpiresAt?: string;
};
```

For `sickrat run --env GITHUB_TOKEN='sickrat://oauth/github?scope=repo'`, the `oauthTokens` key should be the environment variable name.

## Request Flow

### Existing Connection

1. CLI creates an approval request with provider id, scopes, message, command, device id, and request public key.
2. Worker verifies the paired device signature and stores a pending approval.
3. Worker sends realtime and push notifications to the PWA.
4. PWA displays provider, account, scopes, command, device, requested duration, and prior history.
5. User unlocks the vault key with passkey.
6. PWA decrypts the stored refresh token.
7. PWA or Worker exchanges the refresh token for a new access token.
8. PWA seals the access token into the same encrypted grant envelope used for secrets.
9. CLI consumes the grant once and injects the token into the child process or returns it to the requesting agent.

### Just-In-Time Connection

If no matching connection exists, approval becomes a connect-and-approve flow:

1. PWA shows that the requested provider or scopes are not connected.
2. User taps Connect.
3. PWA starts OAuth authorization with PKCE and the requested scopes.
4. Provider redirects back to the vault callback route.
5. PWA stores the refresh token encrypted as a new connection.
6. PWA continues the original approval and seals a short-lived access token for the CLI.

This mirrors missing-secret creation: the user can create the missing credential during the approval, and the original request continues.

## Token Exchange Trust Boundary

Static secret approvals currently keep plaintext away from the Worker. OAuth refresh is harder because many token endpoints either require a client secret or do not allow browser CORS.

V1 should support a user-owned Worker token-exchange proxy:

- PWA decrypts the refresh token only after passkey unlock and approval intent.
- PWA sends the refresh token to its own Worker over HTTPS for the token exchange.
- Worker calls the provider token endpoint and returns the access token response.
- Worker does not persist plaintext refresh tokens or access tokens.
- PWA seals the access token to the CLI request public key.

This means the Worker may transiently see OAuth token material. The PWA should label these connections as "Worker-assisted refresh" in internal metadata, and the threat model should be updated accordingly. Where a provider supports browser-safe PKCE refresh with CORS and no client secret, the PWA can refresh directly and preserve the stronger "Worker never sees plaintext" property.

## OAuth App Configuration

Provider OAuth apps are a separate product concern from vault ownership.

V1 supports provider definitions that work with public clients and PKCE. The user creates a provider OAuth client, copies the callback URL from the PWA into that client, and stores the public client ID from the Connections screen. Cloudflare requires authorization code, PKCE `S256`, token endpoint authentication `none`, and the `refresh_token` grant.

Providers that require a client secret need a later extension because that secret must be encrypted before storage and decrypted only for Worker-assisted exchange. The longer-term modes are:

- **User-provided OAuth app:** the user enters client id and client secret in the PWA; client secret is encrypted in the vault and used only during connect/refresh.
- **Public Sickrat app:** acceptable only for providers that allow public clients, PKCE, and no client secret.
- **Optional redirect broker:** a hosted Sickrat service may help with redirect URI limitations, but must not store tokens. This is a later decision because it weakens the current no-central-service story.

Arbitrary user-owned `workers.dev` URLs are not accepted as redirect URIs by many OAuth providers. The PWA needs clear setup states when a provider requires a custom OAuth app.

## Scope UX

Scopes are the main approval decision.

The approval screen should show:

- provider name and icon
- connected account identity
- requested scopes grouped by risk
- new scopes compared to the existing connection
- why the agent says it needs them
- command and working directory
- requesting device
- one-shot vs timed local grant duration
- whether a new provider connection will be created

Risk grouping should be local catalog metadata:

- Low: read profile, read public data
- Medium: read private data, read repository contents, list workspace data
- High: write data, delete data, admin/account scopes
- Sensitive: billing, security settings, user impersonation, broad offline access

If an agent requests scopes wider than an existing connection, the PWA should require a fresh provider consent flow or make the user choose a narrower existing connection. It should not silently mint a token with scopes that were not previously granted.

## PWA UX

Add a `Connections` section to the app navigation.

Views:

- **Connections list:** connected providers, account labels, granted scopes, last used, expiry/health, revoked state.
- **Provider catalog:** supported providers, connection status, setup requirements, common scopes.
- **Connection detail:** account identity, granted scopes, refresh status, audit history, disconnect/revoke.
- **Connect flow:** provider explanation, scope picker, OAuth app setup if needed, OAuth redirect progress.
- **Approval flow:** typed resource list with both secrets and OAuth tokens.

The dashboard should include "Connections" next to Secrets, Grants, and Machines.

## CLI UX

Recommended commands:

```sh
sickrat providers
sickrat connections
sickrat run --env ENV='sickrat://oauth/provider?scope=scope-a&scope=scope-b' -- <command...>
sickrat run --env-file <file> -- <command...>
```

`sickrat providers` can list catalog support and whether a connection exists without revealing token values.

`sickrat connections` can show provider/account/scope metadata. It should not require vault unlock because the metadata is non-secret, but it should be clear that a listed connection does not imply access without approval.

Timed local grants should work like secret grants. The CLI may cache approved access tokens encrypted until either the approved access window or the provider token expiry, whichever comes first. It must not cache refresh tokens.

## Worker API

Implemented endpoints:

```text
GET  /api/oauth/providers
PUT  /api/oauth/providers/:id/config
GET  /api/oauth/connections
POST /api/oauth/connections
GET  /api/oauth/connections/:id/resolve
POST /api/oauth/connections/:id/revoke
POST /api/oauth/token
POST /api/oauth/identity
```

Existing endpoints to extend:

```text
POST /api/approval-requests
GET  /api/approvals
GET  /api/approvals/:id
POST /api/approvals/:id/grant
```

Schema additions:

```sql
CREATE TABLE IF NOT EXISTS oauth_connections (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  account_subject TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  token_type TEXT NOT NULL,
  access_token_expires_at TEXT,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  refresh_token_salt TEXT NOT NULL,
  refresh_token_kdf TEXT NOT NULL,
  provider_metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_provider_configs (
  provider_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add columns to `approval_requests`:

```sql
ALTER TABLE approval_requests ADD COLUMN resource_requests TEXT;
```

## Audit Events

Audit should record metadata, not token values:

- provider id
- connection id
- account label/handle
- requested scopes
- granted scopes
- device id
- command
- approval message
- approved/denied
- token expiry
- access window expiry
- whether refresh was direct PWA or Worker-assisted

## Security Rules

- Never store access tokens in D1 unless encrypted and short-lived.
- Never store refresh tokens outside encrypted vault records.
- Never return refresh tokens to the CLI.
- Do not allow OAuth token grants from unpaired or revoked devices.
- Scope order should be normalized before signing approval payloads.
- Device signatures must cover typed resource requests, not only legacy `secretRefs`.
- A request for broader scopes than the stored connection has must require new provider consent.
- Revoking a connection should prevent future grants and attempt provider revocation when supported.
- Denied and expired requests must not be reusable.

## Implementation Status

Implemented:

1. Typed signed requests and encrypted OAuth grant payloads.
2. D1 connection storage and approval resource metadata.
3. Generic static provider catalog with Cloudflare as the first entry.
4. Canonical CLI URI parsing and environment injection.
5. Mixed-resource approval UX and connect-during-approval.
6. Connections catalog, setup, connect, scope display, and disconnect.
7. Generic PKCE authorization, refresh exchange, identity lookup, and rotating refresh-token storage.
8. Provider-expiry-aware encrypted timed grants.
9. Parser and Worker API tests.

Remaining follow-up work includes provider revocation calls, richer audit history, account selection where providers expose multiple accounts, and additional providers.

## Open Decisions

- Whether OAuth app client secrets are encrypted vault records, Worker secrets, or both depending on provider.
- How much provider catalog metadata should ship statically versus be user-editable in the PWA.
- Whether a central redirect broker is acceptable later for providers with rigid redirect URI rules.
