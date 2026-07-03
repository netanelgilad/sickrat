# Feature Request: Long-Pending Approval Requests

## Problem

Scheduled jobs that use `sickrat run --access-for 8h` still need the phone approval to happen inside the short pending-request window, currently about two minutes.

`--access-for` works as a post-approval local grant lifetime. It does not keep the approval request itself alive. For unattended or semi-attended scheduled jobs, this creates a bad user experience:

- Job starts at a fixed time.
- Sickrat sends an approval notification.
- User misses the notification for a few minutes.
- CLI times out the pending approval.
- The scheduler or agent retries the same `sickrat run`.
- User receives repeated notifications, each requesting the same full secret bundle.

Concrete observed case:

- A daily finance scraper runs at 18:00.
- It requests Leumi, Isracard, and Visa Cal credentials as one Sickrat bundle.
- The first two pending approval requests expired before the user approved.
- A third identical request was sent and finally approved.
- After approval, the grant was cached for 8 hours as expected.

The repeated notifications were caused by the short pre-approval request TTL, not by the `--access-for` grant duration.

## Desired Behavior

Support approval requests that can remain pending for a longer period, such as a few hours, without requiring the caller to resend the request.

Example CLI shape:

```sh
sickrat run \
  --env-file .env.sickrat \
  --approval-timeout 4h \
  --access-for 8h \
  --message "Approve credentials for the scheduled daily finance scraper" \
  -- npm run scrape
```

Possible names:

- `--approval-timeout <duration>`
- `--request-ttl <duration>`
- `--pending-for <duration>`

The distinction should be explicit:

- `--approval-timeout` / request TTL: how long the phone approval link remains valid before approval.
- `--access-for`: how long the approved local grant can be reused after approval.

## Requirements

- The CLI should keep waiting for approval until the configured approval timeout expires, the request is denied, or the user cancels the CLI process.
- The PWA approval URL should remain valid for the configured pending duration.
- Push notification should still be sent once when the request is created.
- The approval screen should show that the request has a longer pending lifetime.
- After approval, the existing `--access-for` grant behavior should remain unchanged.
- If no `--approval-timeout` is provided, preserve the current default behavior.
- Enforce a reasonable maximum pending duration to avoid stale approvals. For example, cap at 8h or 24h.
- Expired requests must not be approvable later.
- Denied requests should end the waiting CLI process promptly.

## Security Notes

Long-pending requests increase the chance that a user approves stale work. The approval screen should make the request age and command context clear:

- requesting machine/device
- command or command summary
- requested refs
- message
- created time
- expiry time

Consider requiring a clearer warning for long pending windows, for example any `--approval-timeout` over 15 minutes.

## Acceptance Criteria

1. `sickrat run --approval-timeout 4h --access-for 8h ...` sends one approval notification and waits up to 4 hours.
2. Approving after the current short default window, for example after 10 minutes, still starts the child process.
3. After approval, repeated `sickrat run` calls for the same refs reuse the cached timed grant until `--access-for` expires.
4. If the approval is denied, the CLI exits non-zero without spawning the child process.
5. If the approval timeout expires, the CLI exits non-zero and the approval URL can no longer approve the request.
6. Existing commands without `--approval-timeout` keep their current behavior.
