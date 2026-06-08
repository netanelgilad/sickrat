# Sickrat Agent Skill

Use Sickrat when a task needs a secret, API key, token, password, or private configuration value.

## Principle

Do not ask the user to paste secrets into chat. Request the secret through Sickrat so the user can approve access from their phone.

## Setup

If the machine is not paired yet:

```sh
sickrat pair <your-sickrat-vault-url>
```

Show the pairing code to the user and ask them to approve it in the Sickrat web app.

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

## Agent Behavior

- Explain why the secret is needed before requesting it.
- Put that explanation in `--message` so it appears on the user's approval screen.
- Request the narrowest secret reference that satisfies the task.
- Never print secret values unless the user explicitly asks for that in a clearly non-production test.
- Prefer `sickrat run` or env injection once available, so plaintext only reaches the child process that needs it.
- If using `sickrat add-secret`, warn the user that providing the secret through chat may expose it to the model provider.
