# Sickrat

Sickrat is a local-first secrets manager for agents and automation. It is designed to let a CLI request temporary access to secrets only after the account owner approves the request from their own user-controlled backend.

Sickrat is not a hosted multi-tenant secrets service. It provisions and talks to Cloudflare resources in the user's own Cloudflare account, so the user owns the Worker, D1 database, Durable Objects, storage, logs, and encrypted vault records.

## Status

The active code in this repo currently includes:

- `apps/cli`: a Bun/TypeScript CLI named `sickrat`
- `apps/site`: an Astro public product site deployed to `sickrat.dev`
- `apps/web`: a React/Vite PWA console and Cloudflare Worker artifact deployed into each user's Cloudflare account by the CLI
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
  site/            Astro public product site for sickrat.dev
  web/             React PWA console and Cloudflare Worker artifact for user-owned vaults
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

Run the public Astro site locally:

```sh
npm run site
```

Run the CLI from source:

```sh
npm run cli -- --help
```

Type-check and build the workspaces:

```sh
npm --workspace apps/cli run typecheck
npm --workspace apps/site run typecheck
npm --workspace apps/web run typecheck
npm run site:build
npm run web:build
```

The Worker test harness is present under `apps/web/test`, but it currently depends on the Cloudflare Vitest/Wrangler assets configuration being completed.

Build the PWA/Worker bundle:

```sh
npm run web:build
```

Deploy the public site:

```sh
npm run site:deploy
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
sickrat run [--env KEY=ref] [--env-file <path>] [--message <why>] -- <command...>
sickrat reveal <ref> [--message <why>]
```

Use `--message` when an agent requests a secret so the phone approval screen explains the task, not just the reference name.
Use `run` for normal agent workflows; it injects approved secrets into the child process environment without printing them.
Use `reveal` only for explicit manual/debug flows because it prints the approved value to stdout.
If the requested reference does not exist yet, the approval screen can collect the value, save it into the vault, and approve the original request in one flow.

Planned commands include vault listing and safer delivery modes beyond environment variables. See [docs/cli.md](docs/cli.md).

## Install The CLI

Sickrat CLI is distributed as compiled binaries from GitHub Releases.

On Apple Silicon Macs:

```sh
curl -L https://github.com/netanelgilad/sickrat/releases/latest/download/sickrat-darwin-arm64 -o sickrat
chmod +x sickrat
mkdir -p ~/.local/bin
mv sickrat ~/.local/bin/sickrat
```

On Intel Macs, replace the asset with `sickrat-darwin-x64`. On Linux, use `sickrat-linux-arm64` or `sickrat-linux-x64`.

The first release channel is GitHub Releases because the CLI is a compiled Bun binary and also needs the matching Worker/PWA artifact used by `sickrat vault create`. npm and Homebrew packaging can sit on top of this release channel later, but they should not be the source of truth for the deploy artifact.

## Releases

Tagged releases are prepared by GitHub Actions. Pushing a tag like `v0.1.0` type-checks the CLI, cross-compiles standalone CLI binaries with Bun, uploads the binaries as workflow artifacts, and creates a GitHub release.

Current release targets:

- `sickrat-darwin-arm64`
- `sickrat-darwin-x64`
- `sickrat-linux-arm64`
- `sickrat-linux-x64`
- `sickrat-web-dist.tar.gz`

Linux x64 uses Bun's baseline target for broader CPU compatibility.

## Security

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome while Sickrat is moving quickly. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please keep security-sensitive design changes tied to the threat model.

## License

Sickrat is released under the MIT License. See [LICENSE](LICENSE).
