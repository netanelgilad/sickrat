---
name: sickrat
description: Provision a user-owned Sickrat Cloudflare vault and request secrets through phone-approved CLI grants without asking users to paste credentials into chat.
---

# Sickrat Agent Skill

Use Sickrat when a task needs a secret, API key, token, password, or private configuration value.

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
curl -L https://github.com/netanelgilad/sickrat/releases/latest/download/sickrat-darwin-arm64 -o sickrat
chmod +x sickrat
mkdir -p ~/.local/bin
mv sickrat ~/.local/bin/sickrat
```

On Intel Macs, use `sickrat-darwin-x64`. On Linux, use `sickrat-linux-arm64` or `sickrat-linux-x64`. If no release asset exists for the user's platform, stop and tell the user Sickrat does not currently ship a binary for that platform. Do not install Wrangler for normal Sickrat setup; `sickrat vault create` deploys through the Cloudflare API directly.

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

## Pair This Machine

If the machine is not paired yet:

```sh
sickrat pair <your-sickrat-vault-url>
```

Show the pairing code to the user and ask them to approve it in the Sickrat web app.

If `sickrat vault create` just ran successfully, use the printed vault URL. Do not guess a hosted URL.

If push is enabled, the user should receive a pairing notification on their installed PWA. If not, tell them to open the vault PWA, go to Machines, enter the six-digit pairing code, and approve the device.

## Requesting A Secret

Request a secret by reference:

```sh
sickrat request <secret-ref> --message "<why this secret is needed>"
```

Examples:

```sh
sickrat request openai/api-key --message "Run the smoke test against the real API"
sickrat request prod/database/url --message "Apply the requested database migration"
```

The user receives an approval prompt. After approval, Sickrat returns a short-lived grant for the CLI process.

If the reference does not exist yet, still request it with a clear message. The user can create the missing secret from the approval screen and approve the same request.

## Agent Behavior

- For a first-time user, run `sickrat login` and `sickrat vault create` before pairing.
- Treat the printed Worker/PWA URL as the user's private vault endpoint.
- Do not read, print, summarize, upload, or inspect `~/.sickrat/config.json`; it is CLI-private state and may contain Cloudflare OAuth tokens and device keys.
- Explain why the secret is needed before requesting it.
- Put that explanation in `--message` so it appears on the user's approval screen.
- It is valid to request a new reference that may not exist yet, but make the need specific and narrow.
- Request the narrowest secret reference that satisfies the task.
- Never print secret values unless the user explicitly asks for that in a clearly non-production test.
- Prefer `sickrat run` or env injection once available, so plaintext only reaches the child process that needs it.
- If using `sickrat add-secret`, warn the user that providing the secret through chat may expose it to the model provider.
