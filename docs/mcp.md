# Sickrat Vault MCP

See [native iOS migration](native-ios-migration.md) for the current owner app, key recovery, link handoff, and intentional CLI boundaries.


`sickrat mcp` serves the existing paired-device approval flow over MCP. It runs
on a trusted machine that is already paired with the vault, including a
self-hosted Executor machine. It does not run inside the Cloudflare Worker:
the Worker must not gain the private key needed to decrypt grants.

## Local MCP clients

Pair once using `sickrat pair <vault-url> --label executor`, approve the device
on your phone, then configure a process-based MCP client:

```json
{
  "mcpServers": {
    "sickrat": { "command": "sickrat", "args": ["mcp"] }
  }
}
```

The default transport is stdio. Protocol messages use stdout; request progress
uses stderr. No Cloudflare owner login is needed. The process uses the current
pairing in `~/.sickrat/config.json`; do not change that pairing while serving.

## HTTP for Executor

Executor imports MCP over HTTP and cannot spawn a stdio process. Create a
credential file locally without printing its value:

```sh
mkdir -p ~/.sickrat
node -e 'require("node:fs").writeFileSync(require("node:os").homedir()+"/.sickrat/mcp-token", require("node:crypto").randomBytes(32).toString("base64url"), {mode:0o600,flag:"wx"})'
sickrat mcp --transport http --port 8789 --token-file ~/.sickrat/mcp-token
```

The Streamable HTTP endpoint is `http://127.0.0.1:8789/mcp`. All requests,
including initialization and tool discovery, require
`Authorization: Bearer <token>`. The token is read once at startup. To revoke or
rotate access, stop the server, replace the credential file, and restart it.
A token grants access to this entire paired-device principal; use a separate
process, OS account, and pairing for a different trust boundary. Never share
one endpoint among mutually untrusted users.

For a remote Executor host, put a TLS reverse proxy or private tunnel in front
of the loopback listener, and start with
`--public-url https://your-mcp-host.example/mcp`. That option adds the exact
public Host header to the allowlist; it does not provision a tunnel. The proxy
must preserve the Authorization header and forward only the `/mcp` endpoint.
Browser Origin headers are rejected; this server is for server-to-server MCP.
GET and DELETE return 405 because the endpoint is stateless, without persistent
SSE sessions. Bodies are limited to 64 KiB.

Import the endpoint as a remote MCP integration in Executor. This endpoint
uses a bearer API key, not OAuth discovery. Store the token in an Executor
secure account field, and derive the Authorization header from that account.
Executor's `mcpRouter` supports this through its `account` and `headers` options;
its API-key account setup is required when quick-add cannot infer credentials.
Do not paste the credential into app source, tool arguments, or chat. For a
self-hosted Executor in a container, its own `127.0.0.1` is not the host listener;
use the reachable HTTPS proxy address.

## Tools and lifecycle

| Tool | Behavior |
| --- | --- |
| `vault_status` | Current local pairing metadata, never keys or owner credentials |
| `list_oauth_providers` | Provider configuration and supported scopes |
| `list_oauth_connections` | Active connection metadata, never refresh tokens |
| `request_access` | Starts a fresh phone approval; returns an opaque local ticket |
| `collect_access` | Polls pending status and approval URL, then returns approved plaintext once |
| `cancel_access` | Stops local collection and discards any stored result |

Example arguments to `request_access`:

```json
{
  "resources": [
    { "type": "secret", "ref": "service/api-token" },
    { "type": "oauth_token", "providerId": "x", "connectionName": "personal", "scopes": ["tweet.read", "users.read"] }
  ],
  "message": "Read account data for the requested report",
  "approvalWaitSeconds": 120
}
```

Poll `collect_access` with `{ "ticket": "<returned-ticket>" }` about every two
seconds. OAuth tokens are keyed by `MCP_TOKEN_<resource-index>` in the returned
grant; secret values are keyed by their reference. An approved collection
consumes the ticket. A lost collection response cannot be replayed; request
fresh approval if needed. Do not display collected values in conversation or
logs. Static secret values are not made short-lived merely by granting access.

The phone approval identifies the command as an MCP plaintext collection.
Requests use the existing signed-device protocol, ephemeral decryption key,
resource validation, and phone approval UI. No timed grant cache is read or
written. Tickets and results live only in memory, with a maximum of 20
outstanding tickets. Uncollected results expire at the earliest of 60 seconds
after retrieval, the original approval deadline, and any returned OAuth token
expiry. Restarting loses all tickets. Cancellation aborts local polling; a
pending approval on the phone expires normally, and is not marked denied.
Revoking the paired device uses the existing iOS app Devices screen.

## Interface parity and intentional limits

OAuth metadata matches the existing `provider list` / `connection list` CLI
commands and iOS app views. Access uses the same iOS app approval workflow as `run`
and `reveal`, including collecting a missing secret during approval. The iOS app
remains the authority for pairing, approval, device authentication, connection setup,
and reauthorization. It cannot host a persistent local HTTP/stdio listener,
so transport startup and bearer credential files are intentionally host-only.
Local tickets are transport state; cancelling one does not change vault state.

This first server exposes no shell execution, infrastructure administration,
vault unlock, browser-session artifacts, or refresh-token delivery. Browser
sessions retain their existing CLI transaction/commit protocol. Secret and
OAuth access are the supported executor use case; broader management tools
can be added with the same authority boundaries.

## Verification

`npm --workspace apps/cli test` covers MCP SDK discovery and calls over
in-memory and HTTP transports, authentication and Host/Origin checks, input
validation, capacity limits, failed approvals, cancellation, expiration, and
single-use collection. `npm --workspace apps/cli run build` includes the server
in the release binary. A live phone approval and an Executor account connection
must be exercised on the deployment host after configuring its pairing and
endpoint; unit tests use a fake approval backend.
