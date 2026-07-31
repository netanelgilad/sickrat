# `@sickrat/browser-session`

Browser-independent Node.js access to an approved Sickrat browser-session
transaction.

```js
import { openGrantedBrowserSession } from "@sickrat/browser-session";

const transaction = openGrantedBrowserSession();
const { bundle, access, resourceRef } = await transaction.read();

// Browser launch, storage restoration, HTTP calls, and auth checks are userland.
const updatedBundle = await doProviderWork({ bundle, access, resourceRef });
await transaction.commit(updatedBundle);
```

Call `transaction.abort("reauth_required")` rather than committing logged-out
state. Other safe reasons are `unchanged`, `user_cancelled`, and
`operation_failed`.

The SDK reads descriptor 3 and writes descriptor 4 by default through the
non-secret descriptor-number environment variables set by the Sickrat CLI. It
does not use a browser, network socket, storage-state file, or persistent
profile.
