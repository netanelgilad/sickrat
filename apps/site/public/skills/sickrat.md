---
name: sickrat
description: Provision and update a user-owned Sickrat Cloudflare vault, then request secrets or short-lived OAuth access tokens through phone-approved CLI grants without asking users to paste credentials into chat. Use for agent workflows that need private configuration, API credentials, or access to a connected OAuth provider.
---

# Sickrat Agent Skill

Use Sickrat when a task needs a secret, API key, password, private configuration value, or short-lived OAuth access to a connected service.

## Principle

Do not ask the user to paste secrets into chat. Request the secret through Sickrat so the user can approve access from their phone.

Sickrat vaults are user-owned Cloudflare deployments. The public `sickrat.dev` site only hosts docs and this skill file. The user's real vault is a private Worker/PWA created in their own Cloudflare account by the CLI.

## Install The CLI

First check whether the CLI is already available:

```sh
sickrat --help
```

If `sickrat` is missing, install it before setup. Sickrat is distributed as compiled binaries from GitHub Releases. On Apple Silicon Macs:

```sh
curl -L https://github.com/netanelgilad/sickrat/releases/latest/download/sickrat-darwin-arm64 -o sickrat-darwin-arm64
curl -L https://github.com/netanelgilad/sickrat/releases/latest/download/SHA256SUMS -o SHA256SUMS
grep " sickrat-darwin-arm64$" SHA256SUMS | shasum -a 256 -c -
mv sickrat-darwin-arm64 sickrat
chmod +x sickrat
mkdir -p ~/.local/bin
mv sickrat ~/.local/bin/sickrat
```

On Intel Macs, use `sickrat-darwin-x64`. On Linux, use `sickrat-linux-arm64` or `sickrat-linux-x64`. Always verify the selected binary against the matching line in `SHA256SUMS` before installing it. If no release asset exists for the user's platform, stop and tell the user Sickrat does not currently ship a binary for that platform.

## First-Time Setup

If the user does not already have a Sickrat vault URL, perform the owner setup from the CLI:

```sh
sickrat login
sickrat vault create default
```

`sickrat login` opens Cloudflare OAuth in the user's browser. Let the user complete the login. `sickrat vault create` creates the user's isolated vault resources in their Cloudflare account:

- D1 database for encrypted vault records, devices, approvals, and push subscriptions
- Worker/PWA deployment for the phone console
- Durable Object binding for realtime approval delivery
- vault-specific VAPID push keys

Do not create or use a shared Sickrat service account. Use the vault URL printed by `sickrat vault create`.

After vault creation, tell the user to open that vault URL on their phone and add it to the Home Screen. If the CLI prints a `Vault QR` image path, show that image to the user so they can scan it from their phone. The first launch of the installed PWA asks the user to enable push notifications. Wait for the user to confirm that the PWA is installed and push is enabled before running `sickrat pair`.

If the vault PWA says an update is available, run `sickrat vault update --dry-run`, show the plan to the user, then run `sickrat vault update --yes` if they approve. User-owned vaults are updated through the CLI because Sickrat cannot centrally push changes into the user's Cloudflare account.

## Pair This Machine

If the machine is not paired yet:

```sh
sickrat pair <your-sickrat-vault-url>
```

Show the pairing code to the user and ask them to approve it in the Sickrat web app.

If `sickrat vault create` just ran successfully, use the printed vault URL. Do not guess a hosted URL.

If push is enabled, the user should receive a pairing notification on their installed PWA. If not, tell them to open the vault PWA, go to Machines, enter the six-digit pairing code, and approve the device.

## Running Commands With Secrets

Use `sickrat run` as the default agent-facing interface. It requests phone approval, injects approved values into the child process environment, and does not print secret values:

```sh
sickrat run \
  --env OPENAI_API_KEY=openai/api-key \
  --message "<why this command needs the secret>" \
  -- npm test
```

For multiple values, use repeated `--env` flags:

```sh
sickrat run \
  --env SERVICE_USERNAME=service/username \
  --env SERVICE_PASSWORD=service/password \
  --message "Run the requested integration task" \
  -- npm run sync:service
```

Or use an env file with `sickrat://` references:

```sh
sickrat run --env-file .env.sickrat -- npm run sync:service
```

Sickrat replaces only `sickrat://...` values with approved secrets and preserves ordinary env values as-is. Do not write resolved env files back to disk.

`sickrat run --env-file` requests every Sickrat reference in that file as one approval bundle. For least-privilege approval, prefer command-specific env files or direct `--env KEY=ref` mappings that include only the secrets needed for the current command.

For explicit manual debugging only, `sickrat reveal <secret-ref> --message "<why>"` prints a secret to stdout. Avoid `reveal` in normal agent workflows because terminal output may enter transcripts.

The user receives an approval prompt. After approval, Sickrat returns a short-lived grant for the CLI process.

If the user may not see the approval notification right away, ask the CLI to wait longer for that approval:

```sh
sickrat run \
  --env SERVICE_TOKEN=service/api-token \
  --approval-timeout 15m \
  --message "Run the requested integration task; wait longer in case the approval notification is missed" \
  -- npm run sync:service
```

Use `--approval-timeout` only to extend how long the current CLI command waits for the phone approval. It does not grant reusable access. Prefer `10m` or `15m` when the user is nearby but notifications may be delayed; use longer waits only when the request is important and the user has asked for more time. The approval screen and notification show the requested wait duration.

For long-running or multi-step work that may need the same refs repeatedly, the agent may ask for a timed local grant:

```sh
sickrat run \
  --env SERVICE_TOKEN=service/api-token \
  --access-for 30m \
  --message "Work on the requested service task for the next 30 minutes" \
  -- npm run sync:service
```

Use timed access only when the task is actively ongoing and the reason is specific. The phone approval screen is distinct and shows the requested duration. After approval, later `sickrat run` calls on the same paired machine can reuse the encrypted local grant until it expires.

If the reference does not exist yet, still request it with a clear message. The user can create the missing secret from the approval screen and approve the same request.

For password rotation, request the current ref and a new, specific ref in the same `sickrat run` call. The user can generate the new value in the PWA, approve both values, and the child process can complete the provider-specific password change:

```sh
sickrat run \
  --env CURRENT_PASSWORD=service/password \
  --env NEW_PASSWORD=service/password-2026-06-19 \
  --message "Rotate the service password after the provider requested a password change" \
  -- npm run rotate-service-password
```

Only update local config to the new ref after the provider confirms the password change succeeded.

## Requesting OAuth Access

Cloudflare is the first supported OAuth provider. Request an access token through the existing `sickrat run` environment flow with a `sickrat://oauth/<provider>/<connection-name>` descriptor and one or more explicit `scope` parameters:

```sh
sickrat run \
  --env CLOUDFLARE_API_TOKEN='sickrat://oauth/cloudflare/work?scope=account-settings.read&scope=workers-platform.read' \
  --message "List the user's deployed Cloudflare Workers" \
  -- sh -c 'curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts"'
```

Use CLI version `0.1.35` or newer for named OAuth connections. Keep non-sensitive values such as `CF_ACCOUNT_ID` in the normal process environment or env file.

The user manages provider accounts from **Connections** in the installed PWA. It is valid to request Cloudflare access before an account is connected: the approval screen lets the user configure or connect the provider and then continue the same request.

Use the connection name shown in the PWA when more than one account is connected for a provider. The provider-only form, such as `sickrat://oauth/cloudflare?...`, is shorthand that works only when exactly one eligible connection matches the requested scopes.

Request the narrowest scopes required by the command. Every scope must appear as a repeated `scope` query parameter. Do not invent provider ids or request providers that are not shown in the PWA catalog.

The PWA decrypts the provider refresh token only after passkey unlock, mints an access token through the user-owned Worker, and seals that access token to the requesting CLI. The CLI receives only the approved access token. Never ask the user for an OAuth client secret, refresh token, access token, authorization code, or callback URL in chat.

Timed access with `--access-for` also applies to OAuth grants. The CLI caches only the encrypted access-token grant, capped by both the approval window and provider token expiry; it never caches refresh tokens.

## Agent Behavior

- For a first-time user, run `sickrat login` and `sickrat vault create` before pairing.
- Treat the printed Worker/PWA URL as the user's private vault endpoint.
- Do not read, print, summarize, upload, or inspect `~/.sickrat/config.json`; it is CLI-private state and may contain Cloudflare OAuth tokens and device keys.
- Explain why the secret is needed before requesting it.
- Put that explanation in `--message` so it appears on the user's approval screen.
- Use `--approval-timeout` when a missed or delayed phone notification would otherwise make the CLI give up too soon; this is only a wait-time extension for the current approval.
- It is valid to request a new reference that may not exist yet, but make the need specific and narrow.
- Use `--access-for` only for active multi-step work where repeated approval would interrupt the task; prefer a short duration such as `15m` or `30m`.
- Request the narrowest secret reference that satisfies the task.
- For OAuth, request only providers shown in Connections and the narrowest scopes required by the command.
- Prefer `sickrat run` so plaintext only reaches the child process that needs it.
- Keep OAuth access tokens inside the child process environment and never print, inspect, or return them to chat.
- Never use `sickrat reveal` unless the user explicitly asks for plaintext output in a clearly non-production test.
- When a new secret value is needed, prefer the PWA approval flow so the user enters or generates the value on their device instead of sending plaintext through chat.
