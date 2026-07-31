# Browser Session Vault

## Status

This document specifies a first-class Sickrat resource for securely storing and
temporarily granting authenticated browser sessions to automations.

Implementation status as of 2026-07-31:

- the native synthetic, browser-free vertical slice is implemented;
- vault provisioning creates the R2 bucket/binding and browser-session D1
  tables;
- typed approvals, phone-generated and wrapped record keys, one-time leases,
  conditional same-key replacement, the Node.js channel SDK, CLI
  create/run/replace commands, and PWA session management are implemented;
- synthetic create, later-process restore, update, abort, cleanup, and revoke
  paths are covered by automated tests;
- migration of the real ChatGPT artifact and its later-process authenticated
  acceptance run remain the next userland adoption step.

The design is provider-independent. FAIR remains the first finance target, and
the 2026-07-24 ChatGPT spike provides the first completed portability and
structured-protocol evidence.

## Decision

The scraper machine must not retain a persistent browser profile or any other long-lived provider authentication.

Sickrat is the durable home of the encrypted browser session. For each
approved operation:

1. The automation requests a short-lived browser-session grant from Sickrat.
2. The user approves the request on the phone under the existing Sickrat approval and passkey model.
3. The CLI decrypts the session only for the approved child process and sends
   it through a private local process channel.
4. Userland code decides how to consume it: restore a non-persistent browser,
   make an empirically supported direct request, or perform another approved
   operation.
5. The child returns an updated bundle, if any, through a second private
   channel. The CLI validates, encrypts, and replaces the stored object in
   place.
6. The plaintext bundle, local channels, temporary capability, and any
   userland browser state are destroyed.

The authenticated artifact itself is the Sickrat resource. A caller requests
`sickrat://browser-session/<provider>/<account>`, not a generic encryption key
or a local ciphertext pathname. Per-record data keys are generated and wrapped
automatically by Sickrat's existing mobile-held vault-key model; they are
cryptographic implementation details and are never user-managed secret
references.

Store non-sensitive metadata and active leases in D1. Store one current
encrypted artifact object per session in the user-owned R2 bucket. Browser
sessions make R2 part of the vault deployment rather than an optional
large-secret optimization.

The Mac mini must not use the same persistent profile on future runs. A persistent profile may remain useful during early diagnostics, but it is not part of the production architecture and must be removed from the FAIR spike before the browser-session-vault spike is considered complete.

Sickrat core does not launch Patchright, Playwright, Chromium, a remote viewer,
or a Cloudflare Container. Its boundary ends at securely reading and writing a
structured authentication bundle for an approved child process.

## Motivation

Many financial providers use SMS OTP authentication and do not offer OAuth, API keys, or refreshable machine credentials. Logging in from scratch on every scheduled scrape has several drawbacks:

- it requires frequent human input;
- it creates repeated OTP delivery and login traffic;
- it makes unattended or delayed scraping unreliable;
- it can trigger provider login-risk controls;
- it duplicates a login that an ordinary browser session would normally preserve.

An authenticated session is already a credential. Storing it in Sickrat allows the provider to see a continuing browser session while preserving Sickrat's core trust boundary: the scraping machine receives sensitive material only after a narrow, short-lived approval.

This does not eliminate reauthentication forever. Providers can expire or revoke sessions, invalidate refresh tokens, require step-up authentication, or bind a session to device, IP, or browser characteristics. The system therefore needs a remote-browser reauthentication fallback.

## Terminology

### Browser session

A stable Sickrat resource representing one authenticated provider account, for example `fair/primary`.

### Session bundle

The portable authenticated artifact needed to recreate that session. It
contains only standard web authentication storage:

- cookies, including complete security and partitioning attributes;
- local storage;
- IndexedDB state when supported and required;
- session storage captured explicitly when required.

The bundle is not a complete Chrome profile.

### Session grant

A short-lived, request-specific capability that permits a paired process to restore and optionally replace one browser session. It is not a durable local credential.

## Security Invariants

The feature must preserve these properties:

1. **No durable session on the scraper machine.** The Mac mini does not retain a reusable browser profile, storage-state file, decrypted bundle, session key, or cached browser-session grant after the run.
2. **No environment-variable delivery.** Browser sessions are structured, high-value credentials and must not be injected into a child process environment.
3. **No plaintext in Sickrat storage.** Cloudflare stores only encrypted session bundles and non-sensitive metadata.
4. **No Worker decryption.** The Worker coordinates storage, leases, replacement, and grants but cannot decrypt session contents.
5. **Explicit short-lived access by default.** Retrieving a session requires phone approval and passkey unlock. Browser-session resources must not initially participate in reusable timed local grant caches.
6. **Command and device binding.** A grant is bound to the paired device, requesting command, resource id, access mode, current object ETag, and expiry.
7. **Single-writer replacement.** Only one active restore-and-update lease can exist for a session.
8. **No secret observability.** Session contents, cookie names and values, tokens, storage keys, and decrypted payload sizes must not enter logs, notifications, analytics, crash reports, or audit descriptions.
9. **Cleanup is mandatory.** Success, failure, timeout, cancellation, and process signals must all close Sickrat's delivery channels and remove temporary state. Userland is responsible for cleaning up anything it creates.
10. **The artifact is the resource.** Production must not model a browser
    session as a generic secret key plus a local encrypted file. Neither the
    artifact nor a data-encryption key is delivered through an environment
    variable.

An approved child process can still copy or exfiltrate the session while it is authorized to use it. Sickrat cannot prevent a malicious approved process from misusing plaintext after release; it can minimize exposure time, constrain the request, and make the access visible and auditable.

## Architecture

```text
Initial authentication or reauthentication

Phone/user ──controls──> userland browser runner
                         │
                         ▼
                  userland provider adapter
                  verifies logged-in state
                         │
                         ▼
                  capture session bundle
                         │
                         ▼
                  Sickrat CLI encryption
                         │
                         ▼
                  Sickrat encrypted storage


Scheduled scrape

scheduler
   │
   ▼
Sickrat request ──push──> phone approval + passkey
   │
   ▼
short-lived restore-and-update grant + exclusive lease
   │
   ▼
private local input channel
   │
   ▼
approved userland child
   ├── may restore a non-persistent browser
   ├── may call a validated structured protocol
   ├── performs provider-specific work
   └── returns an updated bundle through a private output channel
   │
   ▼
CLI validates + encrypts + conditionally replaces current R2 object
   │
   ▼
close channels + revoke capability + userland cleanup

Invalid session ──> notify user ──> userland reauthentication flow
```

Sickrat should own the resource, bundle envelope, encryption, approval, audit,
lease, safe replacement protocol, and private process delivery. It should not contain
browser-launch code, provider DOM selectors, scraping logic, login flows, or
remote-browser infrastructure. Those belong to userland adapters and runners.
This keeps Sickrat general-purpose while giving it a native browser-session
resource type.

The Worker sees only metadata, wrapped keys, and the current encrypted artifact.
On creation, the mobile client generates a random record data key, wraps it
with the vault key, and seals the plaintext data key to the approved CLI
request key. The CLI uses that data key in memory to encrypt the captured
artifact and uploads ciphertext under its one-time create capability. Restore
reverses that delivery: the PWA unwraps the record key after passkey approval
and seals it to the request key; the CLI downloads and decrypts the current
artifact in memory.

## Product Boundary

The product boundary is intentionally narrower than a browser-automation
platform.

Sickrat core owns:

- the small provider-neutral bundle schema and encrypted envelope;
- secure create, read, replace, revoke, and delete operations;
- phone approval, passkey unlock, grants, leases, conditional replacement, and
  audit;
- encrypted R2 artifact storage and safe D1 metadata;
- private local delivery to and from the specifically approved child process;
- structural validation, redaction, timeouts, cleanup, and safe encrypted
  replacement.

Userland owns:

- the browser engine and automation library, including Patchright, Playwright,
  or another browser;
- where that browser runs, such as the paired Mac, a workstation, or a
  Cloudflare Container;
- interactive login, OTP, CAPTCHA, remote viewing, and logged-in detection;
- provider-specific capture and restore logic;
- selectors, endpoints, headers, request recipes, scraping, browser-native
  requests, direct HTTP requests, and provider compatibility probes;
- temporary browser directories and browser-process cleanup.

A Cloudflare Container can therefore be a userland runner that invokes the
Sickrat CLI as an approved device. It is not where Sickrat must run, and it is
not part of the stored browser-session format.

Sickrat may publish a small SDK for its bundle schema and private-channel
protocol. Optional Patchright helpers and provider code should be separate
packages or examples built on that SDK. Sickrat Worker, PWA, and core CLI must
not depend on a browser runtime or define a provider-adapter interface.

## Why Cookies Alone Are Not Enough

Portable authentication can span several browser storage systems:

- HTTP cookies, including `HttpOnly`, `SameSite`, and partitioned cookies;
- local storage;
- IndexedDB;
- session storage;
- refresh-token state that changes after an authenticated request.

Playwright storage state is a useful baseline because it supports cookies and
local storage and can include IndexedDB. Session storage requires explicit
capture and restoration. Userland must determine which pieces it needs rather
than assuming a cookie-only jar works.

Service-worker state, cache data, browser-bound encryption, or in-memory state
may not be portable. If a provider depends on non-portable profile state,
userland must fail closed and require a fresh login; the solution must not fall
back to keeping a durable Chrome profile on the Mac.

## Userland Consumers

After approval, userland can restore the bundle into a browser, build an HTTP
cookie jar, or use it in another way. Sickrat does not know or approve the
chosen transport because it cannot control the authorized child after
plaintext delivery.

For example:

```sh
sickrat browser-session run chatgpt/primary \
  --message "Read my ChatGPT conversation history" \
  -- node chatgpt-history-reader.mjs
```

The child owns endpoint paths, headers, pagination, response schemas, redirect
policy, cookie-jar behavior, transport selection, compatibility checks, and
safe response handling. None of those recipes are mixed into the session
bundle. If userland needs to store other sensitive configuration, it should use
a separate, explicitly named Sickrat resource.

### ChatGPT protocol spike result

The 2026-07-24 ChatGPT experiment validated this consumer model against the
private web application protocol:

- a fresh browser context restored an authenticated session from the portable
  bundle;
- a second process restored the same session from an AES-256-GCM checkpoint
  whose key was delivered by a timed Sickrat secret grant;
- the actual conversation-list route returned its structured JSON collection;
- cookies plus ordinary compatibility headers received `403`, while sanitized
  browser-observed headers replayed immediately after browser restoration
  received `200`;
- a strict later process using the encrypted cookies and captured request
  headers
  without launching a browser still received `403`;
- no conversation bodies, identifiers, session plaintext, or request-header
  values were persisted or logged.

The stored authorization JWT remained valid for ten days and the bundle
included a short-lived Cloudflare bot-management cookie. The current evidence
therefore suggests browser/network-attestation binding rather than expired
account authentication, but this is an inference. ChatGPT should presently be
classified as supporting portable browser restoration and browser-native JSON
requests, not durable pure-Node HTTP consumption.

The spike's Sickrat-keyed local checkpoint was a temporary development bridge.
It is explicitly not the production resource boundary and should be removed
after the native resource exists. Production stores the current encrypted
artifact object in R2 and never exposes either the artifact or its data key
through an environment variable.

## Resource Identity

The Sickrat reference is the complete identity. Its path is user-chosen and
opaque to the browser-session implementation:

```text
sickrat://browser-session/fair/primary
sickrat://browser-session/ibi/wix-equity
sickrat://browser-session/chatgpt/primary
```

The corresponding typed request should resemble:

```ts
type BrowserSessionResourceRequest = {
  type: "browser_session";
  resourceRef: string;           // browser-session/fair/primary
  access: "restore" | "restore_and_update" | "create" | "replace";
};
```

The signed request and phone approval must display:

- the complete Sickrat reference;
- requesting machine;
- command and working directory;
- restore-only or restore-and-update access;
- current session health and last validation time;
- grant expiry;
- whether the userland command may start an interactive authentication flow.

## Data Model

Non-sensitive metadata and active leases live in D1. Each session has one
current encrypted artifact object in R2. Replacing a session overwrites that
same object key; Sickrat does not retain prior encrypted objects or history.

```ts
type BrowserSessionRecord = {
  id: string;
  vaultId: string;
  resourceRef: string;
  encryptedArtifactObjectKey: string;
  encryptedArtifactEtag: string;
  encryptedArtifactBytes: number;
  wrappedDataKey: string;
  encryptionAlgorithm: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
  expectedExpiresAt?: string;
  state:
    | "creating"
    | "healthy"
    | "unknown"
    | "reauth_required"
    | "revoked";
};
```

The object ETag is an opaque R2 concurrency token, not a Sickrat session
version, and it does not create history. A restore-and-update lease remembers
the ETag it read, and the Worker replaces the object only if that ETag still
matches. This prevents a late or expired process from overwriting a newer
session while still keeping only one stored object.

## Bundle Format

On the private process channel, the bundle is one JSON document represented as
a normal JavaScript object. In R2, that same document is serialized and
encrypted, so R2 cannot inspect its fields.

The initial decrypted shape is intentionally small:

```ts
type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  partitionKey?: string;
};

type StoredValue = {
  name: string;
  value: string;
};

type OriginStorage = {
  origin: string;
  localStorage?: StoredValue[];
  sessionStorage?: StoredValue[];
  indexedDB?: unknown;
};

type BrowserSessionBundle = {
  cookies?: BrowserCookie[];
  origins?: OriginStorage[];
};
```

At least one of `cookies` or `origins` must contain data. Sickrat validates the
container shape, size limits, JSON safety, and cookie/storage field types. It
does not decide whether the contents are sufficient to authenticate.

Bundle fields:

| Field | Meaning |
| --- | --- |
| `cookies` | HTTP cookies that can be placed in a browser context or cookie jar. |
| `origins` | Web storage grouped by the exact origin that owns it. |

Cookie fields:

| Field | Meaning |
| --- | --- |
| `name` / `value` | The cookie key and secret value. |
| `domain` | Which host or host suffix receives the cookie. |
| `path` | Which URL paths receive it. |
| `expires` | Expiration time as Unix seconds; session cookies use the browser library's session-cookie value. |
| `httpOnly` | Whether page JavaScript is forbidden from reading it. |
| `secure` | Whether it may be sent only over HTTPS. |
| `sameSite` | Whether cross-site requests may carry it. |
| `partitionKey` | Optional top-level-site partition for CHIPS/partitioned cookies. |

Origin storage fields:

| Field | Meaning |
| --- | --- |
| `origin` | Exact scheme, host, and port owning the stored data. |
| `localStorage` | Persistent name/value pairs for that origin. |
| `sessionStorage` | Per-browser-session name/value pairs for that origin. |
| `indexedDB` | Optional JSON snapshot of browser database state. Userland owns its encoding and restoration. |

There is no bundle format number initially. A format discriminator should be
introduced only when Sickrat actually needs to distinguish incompatible
shapes.

The bundle is browser-family neutral at the Sickrat boundary. Cookies and web
storage are web concepts; userland translates them into Patchright, Playwright,
a different browser, or an HTTP client's representation. IndexedDB portability
is not guaranteed, so the producer and consumer must agree on its encoding.
Sickrat preserves it without claiming cross-browser compatibility.

Metadata must not include cookie names, storage keys, token values, private
authentication payloads, provider responses, or decrypted artifact sizes.

### D1 and R2 layout

The first schema should use two D1 tables:

- `browser_sessions`: resource reference, wrapped data key, stable R2 object
  key, current R2 ETag, health, and timestamps;
- `browser_session_leases`: session id, request id, device id, base R2 ETag,
  access mode, expiry, and consumed state.

R2 object keys should use opaque record ids rather than provider or account
labels. Each session has one stable key:

```text
browser-session-artifacts/<opaque-session-id>/current
```

The R2 object contains only the authenticated-encryption envelope and
ciphertext. The wrapped data key remains in D1. Creation uses a conditional put
that succeeds only when the stable object key does not already exist.
Replacement uses a conditional put that succeeds only when the current R2 ETag
matches the lease's base ETag. R2 atomically exposes either the complete old
object or the complete new object; it never exposes a partial upload.

After a successful replacement, D1 records the new ETag and timestamps. If
that D1 update fails, the next operation reconciles the safe metadata from the
current R2 object before issuing a grant. No old object, rollback copy, or
abandoned random-key upload is retained.

Creation begins with a short-lived `creating` D1 record so the wrapped data key
and stable object identity exist before upload. The Worker finalizes its health
state only after verifying the R2 object. Timed-out pending creates are
reconciled or deleted by cleanup; they never become restorable without
successful finalization.

## Protocol Operations

The native resource requires command-specific protocol operations:

### Create or replace

1. CLI submits a typed `browser_session` request with resource identity,
   operation, command binding, and an ephemeral request public key.
2. PWA displays the session-equivalent-to-login warning and requires passkey
   approval.
3. For creation, the PWA generates and wraps a record data key. For replacement,
   it unwraps the existing record data key. It seals the plaintext key plus the
   one-time write capability to the request key.
4. CLI runs the userland producer, receives the artifact over the private child
   channel, validates it, encrypts it, and uploads ciphertext.
5. For creation, the Worker finalizes a pending D1 record only after the
   conditionally created R2 object is present. For replacement, it conditionally
   overwrites the same R2 key and then updates safe D1 metadata.

### Restore or restore-and-update

1. CLI requests the session URI and access mode.
2. Worker verifies the paired device and creates the approval session.
3. PWA fetches the wrapped record key, unlocks it locally, and seals the data
   key plus current artifact descriptor, lease id, base R2 ETag, and optional
   write capability to the request public key.
4. CLI downloads ciphertext, validates its digest and authenticated metadata,
   decrypts in memory, and delivers the artifact to the child.
5. For update access, CLI validates and encrypts the returned artifact and
   conditionally replaces the same R2 object only if the base ETag still
   matches.

### Revoke and delete

Revoke immediately denies new grants, expires leases and write capabilities,
and marks the record revoked. Delete removes the one encrypted R2 object and
the D1 record after the configured recovery window. Neither operation requires
Worker-side decryption.

## Encryption and Write-Back

A browser session changes as it is used, so a read-only vault-secret grant is insufficient. The same approval should authorize one atomic restore-and-update transaction.

Recommended envelope design:

1. During `create`, the PWA generates a random browser-session data-encryption
   key after passkey approval. Replacement reuses that record key.
2. The PWA wraps that data key with the vault key and seals the plaintext data
   key to the CLI request public key.
3. The CLI captures the authenticated artifact and encrypts it with the data
   key using authenticated encryption.
4. The Worker stores the wrapped data key and safe record metadata in D1, and
   stores the current encrypted artifact at the session's stable R2 key.
5. During restore, the PWA unwraps the record data key after approval and
   releases it only inside the request's encrypted response envelope.
6. The CLI downloads and decrypts the current artifact in memory,
   then passes it to the approved child over the private process channel.
7. The Worker issues a separate opaque write capability bound to the device,
   session id, base R2 ETag, access mode, and short expiry.
8. The CLI captures and encrypts the replacement artifact with the record data
   key.
9. The Worker accepts the replacement at the same R2 key only if the lease is
   still held and the current object's ETag matches the lease's base ETag.
10. The write capability is consumed once whether the transaction commits or
    aborts.

The associated authenticated data should bind at least:

- vault id;
- session id;
- resource reference;
- stable artifact object key;
- artifact kind (`browser_session`).

The Worker remains unable to decrypt the current object. A failed or
unapproved request reveals no data key.

The CLI interface must never resemble
`sickrat run --env SESSION_KEY=browser-session/...`. Users and agents request
the session URI; data-key unwrap, artifact download, decryption, and local
delivery are internal to `sickrat browser-session`.

Data-key rotation is deferred because changing both the R2 ciphertext and the
D1 wrapped key cannot be one atomic storage operation. A later design can use a
staged key-rotation protocol if rotation is worth the additional recovery
complexity.

## Private Child-Process Delivery

The interface should be command-specific rather than based on environment variables or plaintext files. One possible CLI shape is:

```sh
sickrat browser-session create chatgpt/primary \
  --message "Store my authenticated ChatGPT browser session" \
  -- node adapters/chatgpt-capture.mjs

sickrat browser-session run fair/primary \
  --message "Read the current FAIR portfolio and refresh its authenticated session" \
  -- node provider-probes/fair-portfolio-spike.mjs

sickrat browser-session run chatgpt/primary \
  --message "Read my ChatGPT conversation history" \
  -- node adapters/chatgpt-history-reader.mjs
```

The command after `--` is userland code. Sickrat approves it, starts it, and
transacts the bundle with it; Sickrat does not know whether that command opens
a browser.

For macOS and Linux, the initial process contract uses two anonymous
operating-system pipes:

- input file descriptor: CLI writes one bundle frame and the child reads it;
- output file descriptor: child writes one commit or abort frame and the CLI
  reads it.

The CLI maps the child ends to inherited file descriptors, conventionally
`3` and `4`. It may set these non-secret environment variables so SDKs do not
hard-code the numbers:

```text
SICKRAT_BROWSER_SESSION_INPUT_FD=3
SICKRAT_BROWSER_SESSION_OUTPUT_FD=4
```

Those values are only small integer handle numbers, not credentials. The
session contents never enter the environment. Standard input, standard output,
and standard error remain available for the program's ordinary interaction
and logs.

The pipes are "private" because they are anonymous kernel objects with no
filesystem pathname or listening network port. Only processes that inherit or
are deliberately given the handles can use them. This is capability by
possession, not encryption: the authorized child necessarily sees the
plaintext, and root, a same-user debugger with sufficient permission, a
compromised kernel, or malicious authorized code remains outside Sickrat's
protection boundary.

The delivery is temporary in three ways:

1. the phone-approved Sickrat grant and optional write lease expire quickly;
2. the pipe handles exist only for the CLI/child transaction and close at exit;
3. the decrypted bytes exist only in the CLI and authorized child memory and
   are not cached as a file or reusable environment value.

The encrypted bundle in R2 is durable; the ability to obtain its plaintext is
temporary.

Each direction carries exactly one length-prefixed binary frame:

```text
4-byte unsigned big-endian payload length | UTF-8 JSON payload
```

The input payload is a Sickrat browser-session bundle plus safe
transaction metadata. The output is one of:

```ts
type BrowserSessionResult =
  | {
      action: "commit";
      bundle: BrowserSessionBundle;
    }
  | {
      action: "abort";
      safeReasonCode:
        | "unchanged"
        | "reauth_required"
        | "user_cancelled"
        | "operation_failed";
    };
```

The CLI enforces a configured maximum frame size and deadline before allocating
or parsing the payload. EOF before a complete frame, trailing bytes, multiple
frames, malformed JSON, an invalid bundle container, or a stale or consumed
write lease all fail closed. The CLI closes unused pipe ends immediately and
closes both channels on success, failure, cancellation, or timeout. Inherited
descriptors should be close-on-exec for unintended grandchildren where the
platform permits it.

### Node.js access

The intended Node.js interface is a small browser-independent SDK:

```js
import { openGrantedBrowserSession } from "@sickrat/browser-session";

const transaction = await openGrantedBrowserSession();
const { bundle } = await transaction.read();

// Userland may use Patchright, another browser, or an HTTP client.
const updatedBundle = await doProviderWork(bundle);

await transaction.commit(updatedBundle);
```

The SDK only reads and writes the Sickrat framing protocol. It does not install,
start, or configure a browser. If the operation cannot safely produce a valid
replacement, the child calls:

```js
await transaction.abort("reauth_required");
```

Low-level Node.js code can access the same descriptors with `node:fs`:

```js
import fs from "node:fs";

function requiredFd(name) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isInteger(value) || value < 3) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

const input = fs.createReadStream("", {
  fd: requiredFd("SICKRAT_BROWSER_SESSION_INPUT_FD"),
  autoClose: true,
});
const output = fs.createWriteStream("", {
  fd: requiredFd("SICKRAT_BROWSER_SESSION_OUTPUT_FD"),
  autoClose: true,
});

const request = await readLengthPrefixedJson(input);
const updatedBundle = await doProviderWork(request);

await writeLengthPrefixedJson(output, {
  action: "commit",
  bundle: updatedBundle,
});
```

On the CLI side, Node.js can create and assign those private descriptors while
spawning the child:

```js
import { spawn } from "node:child_process";

const child = spawn(command, args, {
  stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
  env: {
    ...safeEnvironment,
    SICKRAT_BROWSER_SESSION_INPUT_FD: "3",
    SICKRAT_BROWSER_SESSION_OUTPUT_FD: "4",
  },
});

// From the CLI's point of view, fd 3 is writable and fd 4 is readable.
await writeLengthPrefixedJson(child.stdio[3], request);
const result = await readLengthPrefixedJson(child.stdio[4]);
```

`safeEnvironment` must be an explicitly filtered environment and must never
contain the bundle, a data key, a reusable grant, or sensitive provider
metadata.

The framing helpers can be implemented without temporary files:

```js
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

async function readLengthPrefixedJson(stream) {
  const chunks = [];
  let received = 0;

  for await (const chunk of stream) {
    received += chunk.length;
    if (received > MAX_FRAME_BYTES + 4) {
      throw new Error("Browser-session frame exceeds the size limit");
    }
    chunks.push(chunk);
  }

  const frame = Buffer.concat(chunks);
  if (frame.length < 4) throw new Error("Truncated browser-session frame");

  const payloadLength = frame.readUInt32BE(0);
  if (
    payloadLength > MAX_FRAME_BYTES ||
    frame.length !== payloadLength + 4
  ) {
    throw new Error("Invalid browser-session frame length");
  }

  return JSON.parse(frame.subarray(4).toString("utf8"));
}

function writeLengthPrefixedJson(stream, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error("Browser-session frame exceeds the size limit");
  }

  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);

  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(Buffer.concat([header, payload]), resolve);
  });
}
```

This low-level sample reads to EOF for clarity; the production SDK should read
the four-byte header first and then exactly the declared number of bytes, with
a deadline and abort signal.

Required process behavior:

- Sickrat passes the decrypted bundle only over the inherited input descriptor.
- The child returns a result only through the inherited output descriptor.
- The CLI validates only the returned bundle's generic container structure and
  limits before encryption.
- Neither side writes a storage-state JSON file.
- The CLI zeroes buffers where practical, closes descriptors, consumes the grant, and removes its temporary directory.

If userland launches a browser, it should use a non-persistent context. If
Chromium creates temporary profile artifacts internally, userland must place
them in a per-run `0700` directory and remove them in a `finally` path and
signal handlers. For a stricter no-plaintext-on-disk mode, that directory
should live on a memory-backed filesystem.

On APFS/SSD storage, deleting a temporary file does not provide a reliable secure-erasure guarantee. The implementation must therefore avoid intentionally writing the decrypted bundle or reusable profile to disk. Full protection against OS swap, a compromised kernel, process memory inspection, or malicious approved code is outside the application boundary and should be stated explicitly in the threat model.

A restrictive Unix-domain socket can be added later if bidirectional or
multi-message communication becomes necessary. It must live in a per-run
`0700` directory, use owner-only permissions, authenticate the single child,
and be deleted at exit. Anonymous inherited pipes are simpler and expose less
ambient addressability, so they are the initial choice. Windows can use
inherited anonymous handles or an owner-restricted named pipe in a later
platform-specific design.

## Session Lifecycle

### Create

1. The CLI requests `create` for a Sickrat resource reference.
2. The user approves creating that resource.
3. The CLI starts the approved userland producer.
4. If needed, that producer opens a local or remotely viewable browser.
5. The user completes username, OTP, CAPTCHA, or other human input.
6. Userland verifies that authentication succeeded.
7. Userland captures the cookies and web storage it needs.
8. Userland returns the bundle through the private output pipe.
9. The PWA-generated record data key encrypts the complete artifact locally.
10. The CLI conditionally creates the stable R2 object and records its ETag in
    D1 under the one-time create capability.
11. Sickrat destroys the data-key buffer, plaintext artifact, and delivery
    channels; userland destroys any temporary browser context and data.

The UI should not rely on a user pressing "Done" to assert that authentication
succeeded. Userland should verify logged-in state before returning a bundle.

### Daily restore and update

1. Request a `restore_and_update` grant.
2. After phone approval, acquire an exclusive lease containing the current
   R2 ETag.
3. Decrypt and deliver the session to the approved userland child.
4. Userland restores the state into its chosen consumer and performs a
   low-impact authenticated-state check.
5. If valid, userland performs its work.
6. Userland captures the final state after all provider token rotations settle.
7. Return the updated bundle through the private output pipe.
8. Sickrat structurally validates, encrypts, and conditionally replaces the
   same R2 object.
9. Sickrat closes its channels and buffers; userland closes its consumer and
    removes any temporary state.

### Reauthentication

If validation shows the session is expired or revoked:

1. Do not overwrite the last known bundle with logged-out state.
2. Mark the session `reauth_required` using metadata only.
3. Release the lease and destroy local state.
4. Notify the user.
5. Let userland start the same authentication flow used for creation when the
   user is available.
6. Replace the current encrypted object with the newly authenticated bundle
   after verification.

### Revoke

Revocation should prevent future grants, invalidate active leases and write
capabilities, preserve non-sensitive audit history, and delete the current
encrypted session object according to the user's retention preference.
Provider-side logout/revocation is best-effort because many sites expose no
session-revocation API.

## Concurrency and Failure Safety

Only one restore-and-update operation may hold a session lease. This avoids
refresh-token rotation races where two runs start from the same object and a
late write restores stale credentials.

Required behaviors:

- leases have a short TTL and an owner request id;
- updates require a conditional R2 put matching the lease's base ETag;
- a restore-only request cannot write;
- an expired capability cannot commit;
- userland may commit legitimately rotated authentication even if its primary
  work fails;
- userland must abort rather than return logged-out state; Sickrat rejects
  structurally malformed bundles but cannot determine whether a valid-looking
  bundle is authenticated;
- successful replacement removes access to the previous ciphertext; Sickrat
  keeps no rollback history;
- retry logic never reuses plaintext from a previous process.

## PWA Experience

Add a `Browser sessions` or `Sessions` section separate from ordinary secrets.

The list view should show only safe metadata:

- resource reference;
- health state;
- last validated and last updated times;
- expected expiry when known;
- most recent requesting machine;
- whether reauthentication is required.

Actions:

- approve or deny a pending userland create request;
- approve or deny a pending userland reauthentication request;
- inspect audit history;
- revoke;
- delete the encrypted session object.

Approval screens should make it clear that an authenticated browser session is equivalent to being logged into the provider account. The UI should not offer reveal, copy, or download actions for the decrypted bundle.

Initially, creation begins with a userland command such as
`sickrat browser-session create ... -- <producer>`. The PWA approves and tracks
that request but does not launch Patchright or provision a browser runner.
A later optional runner registry could let the PWA ask a paired machine or
container to start userland code, but that is a separate product feature and
must not become a requirement of browser-session storage.

The PWA must not expose record data keys as secrets or offer key creation,
copy, reveal, or rotation controls. Key generation and wrapping happen
automatically as part of session creation, replacement, and future rotation.

## Userland Responsibilities

Sickrat deliberately defines no adapter interface. Userland decides how to
capture, restore, validate, and use the generic authentication containers.
Compatibility markers, browser choice, request recipes, endpoints, headers,
and provider-specific state live in userland code or its own separately named
resources.

The Sickrat SDK supplies only the bundle types and private transaction channel.
Userland receives the approved plaintext bundle while the transaction is
active, but it never receives the vault root key, record data key, or a
reusable Sickrat credential.

## Implementation Plan

### Phase 1: portable-session evidence

Goal: prove provider sessions can be reconstructed without a persistent Chrome
profile and classify their structured-protocol transports.

Completed for ChatGPT:

1. Captured cookies, local storage, IndexedDB, and session storage.
2. Restored the artifact in a fresh non-persistent context.
3. Restored it again from a later process without login.
4. Called the actual conversation-list JSON protocol.
5. Classified browser-native structured requests as supported and strict
   direct Node HTTP as unsupported.

Remaining for FAIR:

1. Complete one FAIR login through the userland interactive browser.
2. Capture Playwright storage state in memory, including IndexedDB.
3. Determine whether FAIR also requires session storage or other explicitly
   portable state.
4. Close the authenticated context completely.
5. Create a fresh non-persistent context and restore only the captured bundle.
6. Verify authenticated state and scrape a read-only portfolio page.
7. Capture the post-scrape state and confirm that a second fresh context can
   use it.
8. Remove the FAIR spike's production reliance on
   `launchPersistentContext` and its stable profile directory.

Exit criteria:

- no reusable browser state remains after the process exits;
- a fresh context can authenticate using only the in-memory bundle;
- the adapter can distinguish healthy, expired, malformed, and logged-out states;
- token/cookie rotation is captured after scraping;
- browser-native and direct HTTP results are documented in userland;
- cleanup works after success, error, cancellation, and forced timeout.

If FAIR cannot be restored from portable state, stop and document the missing browser capability. Do not silently keep a persistent profile.

### Phase 2: Sickrat manual session resource

Goal: store and retrieve the authenticated artifact itself through the normal
phone-approved trust path.

1. Add `browser_session` to the protocol resource-request union.
2. Make R2 an installed vault binding for one current encrypted object per
   session; add D1 session metadata and current ETag.
3. Implement PWA-generated record data keys, vault-key wrapping, and
   request-key sealing for create and restore approvals.
4. Implement create, restore, replace, revoke, and health endpoints without
   any generic secret-key reference.
5. Implement request-scoped artifact delivery and one-time write
   capabilities bound to the approved command and access mode.
6. Add exclusive leases and conditional same-key R2 replacement by ETag.
7. Add `sickrat browser-session create|run|replace|revoke` with the two-pipe
   framed child-process protocol and a browser-independent Node.js SDK.
8. Add PWA list, detail, pending-request approval, health, reauthentication
   status, and revocation views. Do not launch a browser or expose
   key-management UI for record data keys.
9. Extend audit events without recording artifact contents or decrypted sizes.
10. Update the architecture, protocol, threat model, provisioning migrations,
    and recovery documentation.

Exit criteria:

- the Worker cannot decrypt stored sessions;
- the current encrypted artifact object is stored in the user-owned R2 bucket,
  with only safe metadata and a wrapped data key in D1;
- the user and agent request a browser-session URI, never a separate key;
- the Mac receives plaintext only after explicit phone approval;
- no browser-session value or data key is exposed through environment
  variables, stdout, plaintext files, or logs;
- no reusable encrypted artifact is retained on the Mac after the run;
- replacement is atomic and a stale process cannot overwrite the current
  object;
- all temporary local state is removed at the end of the grant;
- Phase 2 passes with a synthetic bundle producer/consumer and no browser
  dependency in the Worker, PWA, core CLI, or channel SDK.

### Phase 3: end-to-end provider adoption

Goal: use Sickrat as the only durable holder of ChatGPT and FAIR
authentication while keeping their browser automation in userland packages.

1. Replace the ChatGPT spike's Sickrat-keyed local ciphertext bridge with a
   native `chatgpt/primary` browser-session record.
2. Approve a later process, restore without login, read paginated conversation
   metadata through `browser_native_http`, rotate, commit, and clean up.
3. Replace FAIR's persistent-profile launch with
   `sickrat browser-session run`.
4. In the userland adapter, hydrate each approved artifact into a fresh browser
   context.
5. In userland, validate, perform provider work, and capture rotations; use
   Sickrat to commit and clean up the bundle transaction.
6. Trigger a phone notification and userland interactive-authentication
   handoff only when reauthentication is required.
7. Exercise successful, expired-session, denied-approval, network-failure,
   child-crash, and conflicting-run paths.

### Phase 4: hardening

1. Introduce bundle evolution machinery only when a concrete incompatible
   shape requires it.
2. Add recovery UX that clearly requires reauthentication when the single
   current bundle is invalid; do not add hidden rollback history.
3. Add Windows inherited-handle support.
4. Fuzz the framing and structural bundle validators.
5. Evaluate narrowly constrained scheduled approval policies only as a
   separate future feature.

Unattended policy grants are deliberately not part of the initial design. A durable machine capability that can retrieve the session without phone approval would weaken the stated boundary that the Mac receives only short-lived Sickrat-approved access. If this is ever added, it needs its own threat model and explicit user opt-in.

## Testing Strategy

### Unit tests

- resource URI parsing and canonical signed payloads;
- cookie and origin-storage container validation;
- rejection of empty, oversized, malformed, or unexpectedly nested bundles;
- authenticated-encryption associated data;
- wrapped record data-key handling without generic secret references;
- capability expiry and single consumption;
- lease acquisition, expiry, and conflict handling;
- conditional same-key R2 replacement by base ETag;
- rejection of structurally malformed replacement state;
- redaction of all session fields from errors and audit events;
- private-frame size limits, truncation, trailing bytes, malformed JSON, and
  multiple-frame rejection;
- input/output descriptor discovery and rejection of invalid descriptor
  environment metadata.

### Integration tests

- encrypt, upload to R2, record D1 metadata, approve, restore, rotate, and
  replace a synthetic session;
- verify an interrupted replacement leaves the complete previous object
  readable and never exposes a partial object;
- verify D1 metadata reconciles with the current R2 ETag after an interrupted
  post-upload metadata update;
- deny and expire approvals without releasing a data key;
- kill the scraper at each lifecycle stage and verify cleanup;
- attempt concurrent restore-and-update operations;
- verify revoked sessions cannot be restored or updated;
- verify the CLI never creates a reusable local ciphertext artifact or
  delivers the artifact/data key through environment variables;
- verify bundle bytes never appear on stdin, stdout, stderr, command
  arguments, or environment variables;
- test child crash, timeout, cancellation, early pipe close, missing result,
  abort result, and stale-ETag replacement;
- prove the core vertical slice with a synthetic Node.js child and no installed
  browser library.

### ChatGPT acceptance test

Using the real session without retaining contents as a fixture:

1. authenticate once through a userland local or remotely viewable browser;
2. create `sickrat://browser-session/chatgpt/primary` and upload its current
   encrypted R2 object;
3. terminate the capture process and remove all local state;
4. approve a new process and restore the R2 artifact without ChatGPT login;
5. read the conversation-list protocol through `browser_native_http`;
6. paginate metadata and retrieve one approved conversation detail without
   logging its content;
7. replace the current encrypted object with the rotated bundle;
8. confirm userland continues using the browser-native path unless a separate
   direct HTTP experiment succeeds.

### FAIR acceptance test

Using a real approved session without retaining its contents as a fixture:

1. authenticate once through a userland local or remotely viewable browser;
2. close the original context;
3. restore into a fresh context;
4. read authenticated portfolio data;
5. commit the rotated session;
6. destroy the context and local state;
7. run again from Sickrat's current stored object;
8. confirm no OTP is required while the provider session remains valid.

## Open Questions

1. Does FAIR require only Playwright storage state, or also session storage or non-portable service-worker state?
2. Should a future, separate runner registry allow the PWA to ask a paired
   machine or container to start a userland capture command?
3. Should the final rotated state be committed when scraping fails after authentication but before data extraction completes?
4. What maximum grant duration safely accommodates slow providers and user-assisted reauthentication?

## First Implementation Step

Build the native storage and transaction slice first, then connect the
already-proven ChatGPT userland adapter:

1. provision the R2 binding and browser-session D1 tables;
2. add typed create and restore approval requests;
3. generate and wrap the record data key in the PWA;
4. implement the two-pipe framed protocol, browser-independent Node.js SDK,
   and conditional same-key R2 replacement;
5. prove create, restore, update, abort, and cleanup using a synthetic Node.js
   producer/consumer with no Patchright dependency in Sickrat;
6. migrate one fresh ChatGPT capture from the separate userland adapter into
   `sickrat://browser-session/chatgpt/primary`;
7. terminate the capture process and prove a later approved process restores
   without login;
8. replace the current object with its rotated bundle and verify no reusable
   local artifact or user-managed key exists.

This vertical slice replaces the development bridge without making Sickrat a
browser runner. FAIR portability can continue separately and then reuse the
same native resource, channel SDK, and userland adapter pattern.

## References

- [Playwright authentication and reusable storage state](https://playwright.dev/docs/auth)
- [Playwright BrowserContext storage-state API](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)
- [Chrome DevTools Protocol Storage domain](https://chromedevtools.github.io/devtools-protocol/tot/Storage/)
- [Chrome DevTools Protocol Network cookie types](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [Cloudflare R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)
- [Cloudflare JA3/JA4 fingerprinting](https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/)
- [Cloudflare JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/)
- [Cloudflare bot-management cookies](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Sickrat architecture](architecture.md)
- [Sickrat protocol](protocol.md)
- [Sickrat threat model](threat-model.md)
