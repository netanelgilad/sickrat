# Contributing

Thanks for helping improve Sickrat. This project is an early prototype, so small focused changes are easiest to review.

## Development Setup

```sh
npm ci
npm run web
```

Useful checks:

```sh
npm --workspace apps/cli run typecheck
npm --workspace apps/web run typecheck
npm run web:build
```

The Worker test harness in `apps/web/test` is still being wired to the Cloudflare Vitest/Wrangler assets configuration. Run it when working on that setup or after the harness is fixed.

Build the CLI locally:

```sh
npm --workspace apps/cli run build
```

## Pull Requests

- Keep changes scoped to one behavior or design decision.
- Include tests when changing protocol, Worker API, approval, or encryption behavior.
- Update docs when changing CLI commands, Cloudflare setup, threat-model assumptions, or release behavior.
- Do not commit local secrets, generated credentials, `.env` files, `.wrangler`, or build output.
- For security-sensitive changes, explain how the change affects [docs/threat-model.md](docs/threat-model.md).

## Reporting Bugs

Please include:

- the Sickrat command or workflow you ran
- expected behavior
- actual behavior
- relevant logs with secrets removed
- OS, Node.js version, Bun version, and Cloudflare/Wrangler version when relevant

## Security Issues

Do not report vulnerabilities in public issues. Use the process in [SECURITY.md](SECURITY.md).
