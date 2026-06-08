# Security Policy

Sickrat handles secrets and approval flows, so vulnerability reports should be private by default.

## Supported Versions

Sickrat is pre-1.0. Security fixes are made on the main development line until versioned releases are formalized.

## Reporting a Vulnerability

Please do not open a public issue for vulnerabilities.

Use GitHub private vulnerability reporting if it is enabled on the repository. If it is not enabled yet, contact the repository owner privately and include:

- affected component
- impact
- reproduction steps or proof of concept
- whether any secret material, account identifiers, or logs are involved
- suggested fix, if known

Avoid sending live secrets, Cloudflare API tokens, private keys, or unredacted vault data.

## Security Scope

Relevant issues include:

- bypassing approval before secret disclosure
- replay or reuse of approval grants
- plaintext secret persistence
- device impersonation or pairing bypass
- incorrect cryptographic envelope handling
- Cloudflare resource permissions broader than required
- logs or diagnostics that expose secrets

Known design tradeoffs and non-goals are tracked in [docs/threat-model.md](docs/threat-model.md).
