---
name: renew-cloudflare-deploy-token
description: Restore a GitHub Actions Cloudflare deployment after CLOUDFLARE_API_TOKEN expires by requesting a short-lived Cloudflare OAuth grant through the user's Sickrat connection, writing it directly to the GitHub repository secret, and optionally rerunning the failed workflow. Use when release or deploy logs show Cloudflare authentication errors such as code 10000 or 9109.
---

# Renew Cloudflare Deploy Token

Use the bundled script to replace the repository's `CLOUDFLARE_API_TOKEN` without exposing it in chat, terminal output, files, or command arguments.

## Diagnose

1. Inspect the failed job with `gh run view <run-id> --log-failed`.
2. Continue only when the Cloudflare deploy failed because its bearer token is invalid or expired. Do not rotate credentials for build, test, configuration, or permission failures.
3. Confirm `gh auth status` succeeds and `sickrat --help` is available. Never inspect Sickrat's private config file.

## Renew and rerun

Run a safe preview first:

```sh
.agents/skills/renew-cloudflare-deploy-token/scripts/renew-cloudflare-deploy-token.sh \
  --repo OWNER/REPO \
  --run-id RUN_ID \
  --dry-run
```

Then run the same command without `--dry-run`. Sickrat requests `account-settings.read`, `workers-scripts.write`, and `workers-routes.write` from the Cloudflare connection and waits up to ten minutes for phone approval. The route scope is required when Wrangler manages a custom-domain route. After approval, the child process sends the temporary access token directly to `gh secret set` over stdin and reruns only the failed jobs in the specified run.

If more than one eligible Cloudflare connection exists, add `--connection NAME` using the name shown in Sickrat. Do not guess a connection name.

## Check the Cloudflare OAuth client when authorization is rejected

If Cloudflare reports that the OAuth client is not allowed to request `workers-scripts.write` or `workers-routes.write`, stop retrying the approval. Confirm the script uses the exact canonical scope IDs advertised by the vault's `/api/oauth/providers` response before changing Cloudflare. Scope IDs can change, while the Cloudflare dashboard shows friendly permission labels.

If the requested canonical scope is correct but still rejected, the Cloudflare OAuth client's scope allowlist may be incomplete. Ask the user to edit the same OAuth client whose client ID is saved under **Connections > Cloudflare** in Sickrat:

1. In Cloudflare, open **Manage Account > OAuth clients** and edit that client.
2. Preserve its existing scopes and add Account Settings Read, Workers Scripts Edit, and Workers Routes Edit, corresponding to `account-settings.read`, `workers-scripts.write`, and `workers-routes.write`.
3. Preserve `authorization_code` and `refresh_token` grants, response type `code`, token endpoint authentication `none`, and the Sickrat callback URL.
4. Save the client, return to Sickrat, and reconnect Cloudflare when prompted. Then rerun the script.

Do not create a different OAuth client or replace the client ID unless the user explicitly chooses to do so. Cloudflare also supports updating the client through `PATCH /accounts/{account_id}/oauth_clients/{oauth_client_id}`, but that requires an existing credential with `OAuth Client Write`; do not ask Sickrat for that scope because Cloudflare's current OAuth catalog does not expose it.

Monitor the replacement run with `gh run watch <run-id>` or `gh run list --workflow <workflow>` and report its final status.

## Security boundary

Cloudflare OAuth does not expose `API Tokens Write` or `Account API Tokens Write`, so this flow cannot mint a durable API token. The GitHub secret receives the short-lived OAuth access token itself. It is intentionally a phone-approved recovery mechanism and will need renewal after expiration.

Never print, verify by echoing, persist, or return either the Cloudflare access token or Sickrat grant. Do not add `--access-for`; each CI credential replacement requires a fresh phone approval.
