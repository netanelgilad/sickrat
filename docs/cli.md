# CLI Design

The CLI should feel familiar to users of tools like the 1Password CLI while adding mobile approval as the core security primitive.

## Commands

```sh
sickrat login
sickrat vault create [name]
sickrat vault status [name]
sickrat vault update [name] [--dry-run] [--yes] [--force-unlock]
sickrat vault list
sickrat vault use <vault>
sickrat self update [--yes]
sickrat update [--yes]

sickrat pair <worker-url>
sickrat run [--env KEY=ref] [--env-file <file>] [--message <why>] [--access-for <duration>] -- <command> [args...]
sickrat reveal <ref> [--message <why>]
sickrat inject -i <template> -o <output>
```

## Sickrat References

Sickrat references use the `sickrat://` URI scheme so the CLI can distinguish values it should resolve from ordinary environment values.

Vault secret refs are arbitrary unique strings inside a vault. URI-style refs are optional for direct `--env KEY=ref` mappings, but env-file auto-detection should use `sickrat://...`.

Examples of valid refs:

```text
service/api-token
openai/api-key
prod/database/url
sickrat://default/openai/api-key
```

OAuth token requests also use the `sickrat://` scheme with the reserved `oauth` namespace:

```text
sickrat://oauth/github/work?scope=repo&scope=read:user
sickrat://oauth/cloudflare/personal?scope=workers-platform.write&scope=d1.write
sickrat://oauth/slack/community?scope=chat:write
```

These are request descriptors, not token material. The CLI parses them into typed OAuth resource requests, the PWA shows provider/account/scopes during approval, and the approved grant injects a short-lived access token into the target environment variable.

The optional path after the provider is the connection name configured in the PWA. Omit it only when exactly one connected account can satisfy the request; Sickrat rejects an ambiguous provider-only request rather than choosing an account implicitly.

The CLI recognizes these descriptors in direct `--env` mappings and env files. It sends a signed typed request, waits for PWA approval, decrypts the sealed access-token grant, validates provider/scopes/expiry, and injects the token into the named environment variable. Refresh tokens never leave the encrypted vault connection.

Cloudflare is the first supported provider. In the PWA, open **Connections**, configure a Cloudflare public OAuth client, and connect an account. The OAuth client must use authorization code with PKCE (`S256`), token endpoint authentication `none`, the `refresh_token` grant, and the callback URL shown by the PWA.

For Atlas Status Cloudflare provisioning, request the narrow Worker and D1 write scopes (and replace the command after `--` with the actual setup command):

```sh
sickrat run --env CLOUDFLARE_API_TOKEN='sickrat://oauth/cloudflare/work?scope=workers-platform.write&scope=d1.write' --message "Configure Atlas Status Cloudflare resources" -- <atlas-status-setup-command>
```

Read-only verification:

```sh
sickrat run \
  --env CLOUDFLARE_API_TOKEN='sickrat://oauth/cloudflare/work?scope=account-settings.read&scope=workers-platform.read' \
  --message "Verify the connected Cloudflare account and list Worker scripts" \
  -- sh -c 'curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts"'
```

## `run`

`sickrat run` resolves references, requests mobile approval, injects plaintext values into the child process environment, and removes plaintext from CLI-owned buffers after the process exits or fails to spawn.

Agents should include `--message` whenever they request approval so the phone screen explains the work being performed, not only the secret reference.
Agents may request a reference that does not exist yet. The PWA should treat that as a just-in-time secret creation flow: collect the value from the user, save it encrypted into the vault, then continue the same approval.
Agents may also request generated values for new refs when a workflow needs a fresh password or token. Keep that inside `sickrat run` rather than adding provider-specific commands. See [generated-secret-flows.md](generated-secret-flows.md).
Agents may request OAuth access tokens from connected provider accounts. Keep the approval model the same: the PWA shows provider, account, scopes, command, device, and message, then returns a short-lived encrypted grant after approval. See [oauth-gateway.md](oauth-gateway.md).
Agents may request a timed local grant with `--access-for <duration>` when a multi-step task is expected to need the same refs repeatedly. The phone approval screen should look distinct from one-shot approvals and should make the duration clear. After approval, the CLI may reuse those refs without another phone prompt until the local grant expires.

Example:

```sh
sickrat run --env OPENAI_API_KEY=openai/api-key -- npm test
sickrat run --env OPENAI_API_KEY=openai/api-key --access-for 30m -- npm test
sickrat run --env GITHUB_TOKEN='sickrat://oauth/github?scope=repo&scope=read:user' -- npm run inspect-repo
sickrat run --env-file .env.sickrat -- npm test
```

Input `.env.sickrat`:

```env
OPENAI_API_KEY=sickrat://default/openai/api-key
DATABASE_URL=sickrat://prod/database/url
GITHUB_TOKEN=sickrat://oauth/github?scope=repo&scope=read:user
SHOW_BROWSER=true
```

Behavior:

- Parse `.env` without mutating it.
- Request approval for all referenced secrets and OAuth tokens as one approval bundle.
- Preserve ordinary env values from the env file unchanged in the child process.
- Spawn the child process with resolved environment values.
- Mask secret values in CLI diagnostics.
- Never persist plaintext values to disk. Timed local grants may persist encrypted values until expiry so later `sickrat run` calls can reuse the user's approval.

Use narrow, command-specific env files for least-privilege approvals. `sickrat run --env-file` requests every `sickrat://...` value in the file and leaves ordinary values unchanged.

## `reveal`

`sickrat reveal <ref>` is explicit manual/debug mode. It uses the same phone approval flow, then prints the approved value to stdout. Agents should avoid it unless the user explicitly asks to inspect a non-production value.

## Updates

User-owned vaults cannot be updated centrally from `sickrat.dev`. The CLI owns the update flow:

```sh
sickrat vault status
sickrat vault update --dry-run
sickrat vault update --yes
```

`sickrat vault update` downloads the verified release Worker/PWA artifact, deploys it to the user's Cloudflare account, and writes a remote deployment manifest in D1. `sickrat update` is the combined happy path: update the CLI when needed, then update the selected/default vault.

## `inject`

`sickrat inject` renders templates containing secret references.

Example:

```sh
sickrat inject -i wrangler.toml.tpl -o wrangler.toml
```

Template:

```toml
[vars]
OPENAI_API_KEY = "sickrat://default/openai/api-key"
```

The output file contains plaintext, so the CLI must warn by default and support `--stdout` for piping into another process.

## Security Reality Of Env Vars

Environment variables are useful because most tools support them. They are not perfect. After injection, the child process can read the values, and OS-level tooling may expose process environments in some circumstances.

Future safer modes:

- stdin secret delivery
- short-lived local Unix socket
- temp files with restrictive permissions
- command-specific integrations
- agent protocol integration

## Local CLI State

The CLI stores:

- user-selected Cloudflare account id
- Worker endpoint
- device id
- device private key in the OS keychain when possible
- non-sensitive cache metadata
- encrypted timed-grant cache entries with strict expiries

The CLI must not store vault root keys or plaintext vault secrets.
