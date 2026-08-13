# ChatGPT browser-session HTTP spike

This experiment asks whether a portable authenticated `chatgpt.com` browser
session can drive its structured conversation-list protocol through a direct
HTTP client after the browser is closed.

It is deliberately not a production ChatGPT integration:

- OpenAI documents account data export, but does not publish a supported API
  for live ChatGPT conversation history.
- The web protocol is private and can change without notice.
- The spike performs read-only requests and never persists cookies, request
  headers, conversation identifiers, titles, messages, or response bodies.
- It records only storage-category counts, endpoint parameter names, response
  schema shapes, HTTP status, and whether browser restoration or direct HTTP
  succeeded.

Run the unit tests:

```sh
node --test experiments/chatgpt-session-http/*.test.mjs
```

Run the live spike:

```sh
node experiments/chatgpt-session-http/chatgpt-session-http-spike.mjs
```

To retain the authenticated bundle across probe processes without writing
plaintext session state, provide an encryption key through Sickrat:

```sh
sickrat run \
  --env CHATGPT_SESSION_ENCRYPTION_KEY=browser-session/chatgpt-spike-key \
  --access-for 30m \
  --approval-timeout 15m \
  --message "Encrypt and reuse the ChatGPT browser-session spike checkpoint" \
  -- env CHATGPT_REMOTE_BROWSER=0 CHATGPT_SPIKE_AUTH_TIMEOUT_MS=900000 \
    node experiments/chatgpt-session-http/chatgpt-session-http-spike.mjs
```

The first run captures and encrypts the bundle. Later runs with the same
Sickrat-granted key load it in memory and skip interactive sign-in. The local
artifact contains only an AES-256-GCM ciphertext envelope and non-secret
identity metadata; the key and plaintext bundle are never written by the
experiment. Set `CHATGPT_SESSION_RESET=1` to deliberately replace the
checkpoint through a new login.

The strict HTTP-only diagnostic uses the same checkpoint and does not import
or launch a browser:

```sh
sickrat run \
  --env CHATGPT_SESSION_ENCRYPTION_KEY=browser-session/chatgpt-spike-key \
  --message "Test browserless ChatGPT conversation-list access" \
  -- node experiments/chatgpt-session-http/chatgpt-session-http-only.mjs
```

This encrypted local checkpoint is only a development bridge. The production
browser-session resource must store ciphertext and revisions in the
user-owned Sickrat vault and deliver plaintext through the planned
file-descriptor or Unix-socket grant boundary.

By default, the spike launches a fresh non-persistent headful Chrome instance
through the locally available Patchright transport and prints a short-lived
`remote-browser-ready` URL. Authentication remains fully user-controlled; the
spike does not solve challenges or handle credentials. The tailnet viewer is
the remote-control surface. Open its URL from a device on the same tailnet and
complete ChatGPT authentication. The viewer expires after at most 15 minutes
and permits only view, click, type, and scroll against an exact login-origin
allowlist. A mobile disconnect gets a two-minute reconnection window so
switching to a password manager or OTP app does not immediately destroy the
browser session.

The viewer harness is currently imported from the adjacent
`israeli-finance-control/remote-browser-control` spike. It is a development
dependency only, as is that repository's installed Patchright package;
production code should move both behind explicit package boundaries.

To use a local Chrome window instead:

```sh
CHATGPT_REMOTE_BROWSER=0 \
  node experiments/chatgpt-session-http/chatgpt-session-http-spike.mjs
```

After authentication, the process:

1. observes the authenticated conversation-list JSON response in memory;
2. captures only the `https://chatgpt.com` session state;
3. closes the authentication context;
4. restores the bundle into another fresh context and validates the list;
5. closes the browser context;
6. attempts the same GET with a cookie-aware Node HTTP client;
7. if cookie-only access fails, retries once with the browser-observed request
   headers still held only in process memory;
8. destroys every plaintext session object and browser context.

The stable supported fallback for bulk history ingestion is ChatGPT's account
data export, whose ZIP includes conversation JSON. A production Sickrat
integration should expose the private web protocol only as an explicitly
experimental provider adapter and retain export-file ingestion as the durable
fallback.

## Observed result

On 2026-07-24 the spike demonstrated:

- a captured bundle containing cookies, local storage, IndexedDB, and session
  storage restored an authenticated fresh browser context;
- a later process decrypted the saved checkpoint in memory and restored the
  session without interactive login;
- the real conversation-list request was
  `https://chatgpt.com/backend-api/conversations`, with private query values
  omitted from logs;
- cookie-only Node HTTP received `403`;
- the same-process read-only retry with sanitized browser-observed headers held
  only in memory received `200 application/json`;
- a later strict HTTP-only process loaded the same encrypted cookies,
  authorization value, and request profile without launching a browser, but
  received `403`;
- response output contained schema and counts only, with no conversation
  identifiers, titles, snippets, mappings, or messages persisted.

Two broad JSON-shape classifiers initially matched the prompt library and
scheduled-task collections. The final adapter therefore requires both the
provider-owned conversation-list path and a guarded item schema. Provider
adapters must own private route matching; a generic collection heuristic is
not a sufficient correctness boundary.

The authorization JWT still had a ten-day lifetime, while the bundle also
contained a short-lived Cloudflare bot-management cookie. The evidence
therefore suggests that the durable HTTP-only failure is related to
Cloudflare/browser binding or attestation rather than an expired ChatGPT
login. That is an inference, not a confirmed provider contract.

This proves portable login-free browser restoration and conversation-list
protocol compatibility after browser bootstrap. It does not prove durable
pure-Node access or complete history ingestion. The next protocol spike should
test pagination and individual conversation detail retrieval through a
browser-native request transport, while separately evaluating whether a
non-browser transport can reproduce the required network boundary without
weakening the provider's controls.
