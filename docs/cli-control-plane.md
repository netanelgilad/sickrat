# CLI Control Plane

## Command Model

The CLI has two separate authority levels:

- `sickrat login` and `sickrat vault create` are the owner/admin control plane. They log in to Cloudflare and create account-owned vault resources.
- `sickrat pair ...` is device pairing. It pairs this machine with an already-running Sickrat vault so agents can request secrets.

This separation means one bootstrap agent can create vault infrastructure, while routine agent instances only get paired-device authority.

## Implemented Commands

```sh
sickrat login [--client-id <cloudflare-oauth-client-id>] [--port 8977]
sickrat vault create [name] [--account-id <account-id>]
sickrat pair <worker-url> [--label <device-label>]
sickrat request <ref>
```

`login` uses OAuth authorization code with PKCE and a loopback callback server. Cloudflare's OAuth client API currently documents `authorization_code` and optional `refresh_token` grant types, not device-code. The project client id is the default, and `--client-id` is only for alternate OAuth clients.

`vault create` chooses the Cloudflare account automatically when only one account is available. If multiple accounts are available it prompts in an interactive terminal, or accepts `--account-id` in non-interactive agent runs. It currently creates or finds:

- D1 database: `sickrat-<vault>-vault`
- Worker/PWA deployment: `sickrat-<vault>` on the account's `workers.dev` subdomain
- Durable Object namespace binding: `APPROVAL_HUB`
- Worker asset binding for the PWA shell
- Vault-specific VAPID keys as Worker vars

It intentionally does not create a Secrets Store today. Secret values are encrypted in the PWA before upload; D1 stores ciphertext, metadata, devices, approvals, subscriptions, and audit-adjacent records. Cloudflare Secrets Store should be added only when Sickrat has operational secrets that the Worker itself must read. It should not be used as the primary vault database unless we explicitly decide to make Cloudflare-managed plaintext secret material part of the product model.

Secret references are arbitrary unique strings within a vault. `leumi`, `prod/database/url`, and `sickrat://default/openai/api-key` are all valid. Future env-file auto-detection should use `sickrat://...` as the explicit marker, but direct `sickrat request <ref>` does not require a URI scheme.

The CLI writes the deployed vault URL into `~/.sickrat/config.json` so the next routine command can pair against that vault.

## CLI Secret Add Direction

`sickrat add-secret` should exist, but it needs explicit UX warnings:

- Human direct terminal use is acceptable.
- Agent-mediated use is allowed only after warning that the plaintext secret will pass through the agent/chat/model path.
- For local/private model setups the user may still decide that is fine.

## CLI Vault Unlock Direction

The PWA currently protects the vault key with WebAuthn PRF/passkeys. The CLI should not try to silently reuse that browser-local key.

Recommended first CLI unlock design:

1. `sickrat vault login` asks the PWA for a vault-key export approval.
2. The PWA requires passkey unlock.
3. The PWA wraps a CLI vault key copy to a CLI public key.
4. The CLI stores the wrapped key in the OS keychain where available.
5. `sickrat add-secret` can then encrypt locally without sending plaintext to the Worker.

Passkey support from a pure CLI is less portable than browser WebAuthn. Hardware security keys are practical through FIDO2 libraries, but iCloud Keychain/platform passkeys are primarily exposed through browser/app platform APIs. For our product, the canonical unlock authority should remain the PWA first; CLI vault unlock can be granted by the PWA.
