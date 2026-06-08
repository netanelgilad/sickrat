# Sickrat

Sickrat is a local-first secrets manager for agents and automation. It is designed to let a CLI request temporary access to secrets only after the account owner approves the request from their own user-controlled backend.

Sickrat is not a hosted multi-tenant secrets service. The current prototype provisions and talks to Cloudflare resources in the user's own Cloudflare account, so the user owns the Worker, D1 database, Durable Objects, storage, logs, and encrypted vault records.

## Status

This repository is an early prototype. The active code in this repo currently includes:

- `apps/cli`: a Bun/TypeScript CLI named `sickrat`
- `apps/web`: a React/Vite PWA backed by a Cloudflare Worker
- `packages/protocol`: shared TypeScript protocol helpers and envelope definitions
- `docs`: architecture, CLI, provisioning, protocol, and threat-model notes

Expect breaking changes while the core protocol and deployment flow settle.

## Why Sickrat Exists

Agentic tools often need credentials to do useful work, but handing long-lived secrets to a local process creates a large blast radius. Sickrat's model is:

- secrets are stored as encrypted vault records, not as retrievable Worker secrets
- a paired CLI device can request a secret but cannot decrypt vault storage directly
- each secret access requires an explicit approval flow
- approvals return short-lived encrypted grants for the specific request
- infrastructure lives in the user's own Cloudflare account

See [docs/architecture.md](docs/architecture.md) and [docs/threat-model.md](docs/threat-model.md) for the deeper design.

## Repository Layout

```text
apps/
  cli/             Bun/TypeScript CLI
  web/             React PWA and Cloudflare Worker entrypoints
packages/
  protocol/        Shared request/response and crypto envelope helpers
docs/
  architecture.md
  cli.md
  cli-control-plane.md
  cli-e2e-plan.md
  cloudflare-provisioning.md
  protocol.md
  threat-model.md
scripts/
  create-cloudflare-oauth-client.mjs
```

## Requirements

- Node.js 20 or newer
- npm
- Bun 1.1 or newer for CLI development and compiled binary builds
- A Cloudflare account for Worker/D1/Secrets Store provisioning experiments

## Getting Started

Install dependencies:

```sh
npm ci
```

Run the web app and Worker locally:

```sh
npm run web
```

Run the CLI from source:

```sh
npm run cli -- --help
```

Type-check and build the workspaces:

```sh
npm --workspace apps/cli run typecheck
npm --workspace apps/web run typecheck
npm run web:build
```

The Worker test harness is present under `apps/web/test`, but it currently depends on the Cloudflare Vitest/Wrangler assets configuration being completed.

Build the PWA/Worker bundle:

```sh
npm run web:build
```

Build the CLI for the current machine:

```sh
npm --workspace apps/cli run build
```

## CLI Shape

The implemented CLI currently supports:

```sh
sickrat login [--client-id <id>] [--port <port>]
sickrat vault create [name] [--account-id <id>]
sickrat pair <worker-url> [--label <name>]
sickrat request <ref> [--message <why>]
```

Use `--message` when an agent requests a secret so the phone approval screen explains the task, not just the reference name.

Planned commands include `run`, `inject`, vault listing, and safer delivery modes beyond environment variables. See [docs/cli.md](docs/cli.md).

## Cloudflare OAuth Client Bootstrap

Cloudflare OAuth clients are account resources. Create the `Sickrat` OAuth client in the Cloudflare account that owns the deployed Worker:

1. Create a Cloudflare API token with `OAuth Client Write` for the account.
2. Run:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<token> \
npm run cf:oauth-client
```

3. Set the returned client id on the Worker:

```sh
printf '%s' '<returned-client-id>' | npx wrangler secret put CF_OAUTH_CLIENT_ID
npm run web:deploy
```

The generated OAuth client is configured for Authorization Code with PKCE, `token_endpoint_auth_method: none`, redirect URI `https://sickrat.dev/cf/callback`, and the Cloudflare scopes needed by the current provisioning prototype.

## Releases

Tagged releases are prepared by GitHub Actions. Pushing a tag like `v0.1.0` type-checks the CLI, cross-compiles standalone CLI binaries with Bun, uploads the binaries as workflow artifacts, and creates a GitHub release.

Current release targets:

- `sickrat-darwin-arm64`
- `sickrat-darwin-x64`
- `sickrat-linux-arm64`
- `sickrat-linux-x64`

Linux x64 uses Bun's baseline target for broader CPU compatibility.

## Security

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome while the prototype is still moving quickly. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please keep security-sensitive design changes tied to the threat model.

## License

Sickrat is released under the MIT License. See [LICENSE](LICENSE).
