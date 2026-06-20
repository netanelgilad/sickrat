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

## Secret References

Secret refs are arbitrary unique strings inside a vault. URI-style refs are optional, not required.

Examples of valid refs:

```text
service/api-token
openai/api-key
prod/database/url
sickrat://default/openai/api-key
```

Env-file auto-detection uses `sickrat://...` as the explicit marker so the CLI can distinguish literal values from secret references without extra config. Direct `--env KEY=ref` mappings accept raw refs without a URI scheme.

## `run`

`sickrat run` resolves references, requests mobile approval, injects plaintext values into the child process environment, and removes plaintext from CLI-owned buffers after the process exits or fails to spawn.

Agents should include `--message` whenever they request approval so the phone screen explains the work being performed, not only the secret reference.
Agents may request a reference that does not exist yet. The PWA should treat that as a just-in-time secret creation flow: collect the value from the user, save it encrypted into the vault, then continue the same approval.
Agents may also request generated values for new refs when a workflow needs a fresh password or token. Keep that inside `sickrat run` rather than adding provider-specific commands. See [generated-secret-flows.md](generated-secret-flows.md).
Agents may request a timed local grant with `--access-for <duration>` when a multi-step task is expected to need the same refs repeatedly. The phone approval screen should look distinct from one-shot approvals and should make the duration clear. After approval, the CLI may reuse those refs without another phone prompt until the local grant expires.

Example:

```sh
sickrat run --env OPENAI_API_KEY=openai/api-key -- npm test
sickrat run --env OPENAI_API_KEY=openai/api-key --access-for 30m -- npm test
sickrat run --env-file .env.sickrat -- npm test
```

Input `.env.sickrat`:

```env
OPENAI_API_KEY=sickrat://default/openai/api-key
DATABASE_URL=sickrat://prod/database/url
SHOW_BROWSER=true
```

Behavior:

- Parse `.env` without mutating it.
- Request approval for all referenced secrets as one approval bundle.
- Preserve ordinary env values from the env file unchanged in the child process.
- Spawn the child process with resolved environment values.
- Mask secret values in CLI diagnostics.
- Never persist plaintext values to disk. Timed local grants may persist encrypted values until expiry so later `sickrat run` calls can reuse the user's approval.

Use narrow, command-specific env files for least-privilege approvals. `sickrat run --env-file` requests every `sickrat://...` reference in the file.

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
