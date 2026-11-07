# Sickrat for iOS

The native Swift 6 / SwiftUI app is Sickrat’s only owner-facing app. iOS 18+, Xcode 26+, no web view or third-party iOS packages. The CLI and user-owned Cloudflare Worker remain the agent interface and backend.

## Build and test

```sh
xcodegen generate --spec apps/ios/project.yml
xcodebuild -project apps/ios/Sickrat.xcodeproj -scheme Sickrat -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

For direct installation, archive in Xcode with your paid Apple Developer team, development/ad-hoc profile, registered iPhone, bundle `com.netanelgilad.sickrat`, and APNs entitlement. Export using Xcode’s development or ad-hoc distribution. Keep signing credentials outside the repo. `scripts/build-ipa.sh` and `scripts/publish-preview.mjs` remain optional unsigned AltStore utilities; AltStore is not required. Never create a public release tag from an unmerged branch.

## Setup and recovery

1. Provision your backend with `sickrat login` and `sickrat vault create default`.
2. Install the signed native app and enter the printed HTTPS vault origin.
3. In Settings → Vault recovery, create a key **only for an empty vault**, or restore a recovery file using its password. For an existing key on another iPhone, use Settings → Transfer vault key instead.
4. Save an encrypted recovery backup with a unique password of at least 16 characters. Keep the password separately in your password manager. Files and passwords must both be retained; Sickrat cannot reset them. Backups are not uploaded to the Worker and have no expiry.
5. Enable notifications in Settings. Approve its enrollment code on the owner Mac with `sickrat notifications approve <CODE> --setup-file <private-owner-setup.json>`. The APNs private key and owner credential stay on the Mac/Worker, never in the app.
6. Run `sickrat pair <vault-origin>` and review the pairing code in Settings → Paired devices. A native pairing notification opens that review. Approve access requests from Requests.

The Keychain key requires device passcode/user presence, is `WhenPasscodeSetThisDeviceOnly`, and is cleared from app memory on background. Existing keys are never overwritten. Native creation refuses any vault with secrets, OAuth connections, or browser sessions; failures and malformed responses are not treated as an empty vault. Restoring a backup verifies its encrypted origin and never creates a replacement for an existing key.

Recovery uses AES-256-GCM and PBKDF2-HMAC-SHA256 with a random 32-byte salt and 600,000 fixed iterations. Password derivation runs off the UI actor. Wrong-password, tamper, wrong-origin, and oversized/unsupported file checks fail before Keychain storage. A transfer file expires after ten minutes and is not a durable backup. Keep a tested backup before deleting your source phone/app.

## Native capabilities and intentional boundaries

Requests show pending decisions, three recent items, and on-demand history. Approval is one tap after review, with device authentication when locked and action-local progress. Secrets, OAuth tokens and browser sessions retain existing envelope compatibility. Accounts support connect/reauthorize, naming, scope repair and provider configuration using ASWebAuthenticationSession. The app supports native APNs approval and device-pairing alerts; the icon badge counts unexpired access requests, not pairing requests.

CLI browser links open a small HTTPS handoff page; its button passes only public navigation to the native app. The app only accepts links for its already-connected vault. No link starts consent or approves access automatically. Browser OAuth callbacks remain necessary for provider redirects, but no PWA console or web-key handling ships.

Only owner clients may hold the root key. CLI/MCP clients never receive it or provider refresh tokens. Cloudflare provisioning/deployment and owner APNs configuration remain CLI operations. Native notifications require suitable signing and configured Worker credentials. Cloudflare Access redirects remain intentionally rejected until a native authentication design exists.

## Migration

Read [native migration](../../docs/native-ios-migration.md) before updating an old PWA-only vault. Upgrade the native app and transfer the existing key before removing the old browser console. Legacy passkey records alone cannot be imported as native recovery files. Browser recovery records are not erased by retirement.

## Validation

Unit tests cover encryption parity, key transfer, recovery vectors/tamper rejection, origin-bound links, OAuth policy and loading state. DEBUG fixtures never contact a vault or change real notifications. UI tests cover request decisions, loading, account repair, recovery and settings in light/dark and larger Dynamic Type. Real Keychain prompts, APNs delivery and provider consent still require device verification after a change; simulator checks do not establish those.

## Historical preview notes

The following notes document earlier builds and their then-current PWA dependencies. They are historical, not current setup instructions.

## Preview 0.1.1 (build 2)

Expected URLSession, task and system-authentication cancellations are silent. Refresh failures appear inline with Retry; real action errors still appear as alerts. Initial load, ongoing refresh and foreground actions show progress. Refreshes no longer occupy the action lock. Keychain unlock runs off the main actor so the UI stays responsive; background locking invalidates an in-flight unlock or reveal before it can repopulate sensitive state.

## Preview 0.1.2 (build 3)

Loading follows Apple’s [loading guidance](https://developer.apple.com/design/human-interface-guidelines/loading) and [progress indicator guidance](https://developer.apple.com/design/human-interface-guidelines/progress-indicators). The compact list hierarchy takes inspiration from Apple Passwords and Things, while retaining standard SwiftUI navigation, lists, typography and tab bars. The installed [SwiftUI Expert skill](https://github.com/AvdLee/SwiftUI-Agent-Skill) and local AGENTS.md guide future native UI changes.

Automatic refresh preserves content and scroll geometry without a banner. Pull-to-refresh owns the sole refresh indicator. First load shows content-shaped placeholders, and mutation feedback lives beside the relevant action. Requests with recent history use a compact “No pending requests” row rather than a full-screen empty state. These are native presentation changes; PWA/CLI capabilities are unchanged.

DEBUG-only synthetic fixtures support screenshot review and UI tests for initial load, automatic refresh and unlock feedback. Pull-to-refresh is verified visually during a delayed synthetic response; XCTest waits for the native refresh animation to finish before querying it. Release builds exclude the fixtures.

## Preview 0.1.3 (build 4)

Native account details now support renaming, revocation, reauthorization, changing scopes and shared provider client-ID editing. Approval rows distinguish missing accounts, missing permissions and ambiguous unnamed requests. Repairs open a prefilled sheet over the original request; saving updates account metadata immediately, and only explicit approval grants access. Required request scopes stay selected. Existing active connections retain their ID during reauthorization.

Naming and account selection match CLI/PWA rules. Intentional native protection: reconnecting an existing connection requires the same provider subject; use a separate connection for another account. This prevents accidental identity replacement beneath a name already used by commands. Provider configuration changes apply to every connection for that service. No Worker deployment or protocol changes are required.

Tests cover naming boundaries, revoked/ambiguous accounts, scope matching, identity binding, and cancellation of a repair sheet back to its original request. Native provider consent, refresh-token renewal and a repaired real CLI approval still need an on-device check with the account owner. Existing PWA recovery and notification exceptions remain.

## Preview 0.1.4 (build 5)

Settings → Transfer vault key → Send to another iPhone now exports the existing PWA-compatible encrypted transfer envelope. Start a transfer on the destination iPhone, paste its request on the source iPhone, authenticate again with Face ID/passcode, and save the encrypted JSON with the system Files exporter. Send that file to the destination and import it within ten minutes. A transfer grants full vault access to the recipient; it is not a durable backup and does not revoke the source phone.

The sender validates the request type, version, size, origin and P-256 key before authentication. Changing vaults discards the old incoming transfer key. Exports require fresh Keychain authentication even when already unlocked. The app never exports a plaintext key or sends the root key to a server. The PWA already supports the same owner export; CLI root-key access remains intentionally excluded. PWA passkey recovery is still required for durable recovery. No Worker deployment is needed.

Protocol tests verify the envelope's origin, key and expiry, wrong-recipient rejection and invalid request rejection. UI tests verify the access explanation and disabled export without a request. Actual Keychain authentication, Files handoff and import on a second physical phone require on-device verification.


## Preview 0.1.5 (build 6)

Native Settings → Notifications imports a private setup file, then requests iOS permission and registers the device with the configured vault. Transfer the setup file privately from the vault owner’s Mac to Files on the phone; do not post it or publish it in the AltStore source. Approval alerts contain only a generic message and request ID; tapping opens the corresponding request and refreshes it. Native registrations can be inspected and removed in the web console’s Machines view or with `sickrat notifications list --setup-file <path>` and `sickrat notifications remove <id> --setup-file <path> --yes`. Removing a registration prevents silent re-registration; turn notifications off and back on in the iOS app to enroll again. Apple device-token registration is inherently iOS-only; the CLI and PWA cannot create APNs device tokens.

APNs Worker bindings are `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`, `APNS_ENVIRONMENT`, and `APNS_ENROLLMENT_SECRET` (sandbox or production). They must be installed as Worker secrets. The branch CLI preserves existing APNs secret bindings on subsequent updates, but older released CLIs may remove them. Native notification registration and management require the private setup credential; existing vault APIs retain their own access model, so protect the vault endpoint against unauthorized access. Never place the APNs private key in app binaries or repository files. The development preview uses a topic-specific sandbox key; production signing requires matching production configuration.

Tests cover APNs JWT signing, request routing, token registration and revocation, native-only approval creation, and the notification settings and request-opening UI. Simulator and mocked APNs tests cannot prove real-device delivery or that AltStore retains the entitlement after signing; those require owner verification.

## Preview 0.1.6 (build 7)

Enable Notifications now creates a ten-minute pairing code. The owner approves it on the Mac with `bun apps/cli/src/index.ts notifications approve <CODE> --setup-file ~/.config/sickrat/apns/sickrat-notification-setup.json`, or in the PWA Machines notification management panel after loading its owner setup credential. The iPhone receives no setup file. It generates a random device credential, stored in its Keychain after approval; the server stores only its hash and restricts it to that device's notification token. Owner approval and device management still require the private owner credential. Removing a device also invalidates its enrollment credential. The owner credential is never bundled into the app. This is a Mac-authorized pairing flow, not proof of root-key possession; the current vault has no server-verifiable owner-key identity.

## Preview 0.1.7 (build 8)

Notification enrollment preserves its pending credential in device Keychain. Polling pauses in the background and retries temporary network interruptions, allowing the owner to switch to another app to share the code without abandoning pairing. Process restarts can reuse the pending credential when Enable Notifications is tapped again. Real app-switching behavior and push delivery still require iPhone verification.

## Preview 0.1.8 (build 9) — native product and design

The product rationale, prior-art links, per-screen responsibilities, accessibility and motion rules are in [DESIGN.md](DESIGN.md). Requests now emphasize the requester, purpose, resources and duration; approval controls remain reachable during scrolling. Successful decisions show a receipt. Vault categories are reachable above secrets, search has a distinct no-results state, and secret details use readable dates and a contextual Edit action. Notifications explain pairing and offer native sharing of the public code. Pairing progress is local, allowing navigation and sharing while waiting for the Mac.

Native secret navigation, a brief completion symbol animation and successful-action haptics provide feedback. Reduce Motion uses ordinary navigation and removes custom receipt motion. These changes retain the existing backend, encryption and approval checks; no Worker deployment is required.

Validation for this preview: the complete simulator suite passed, including cryptography, key transfer, OAuth policy, activity, date/duration presentation, loading geometry, request review, vault search and pairing navigation. A separate four-test run passed in dark appearance with Accessibility Extra Large text, including app switching during synthetic notification pairing. Light/dark screenshots were inspected. Signed device archive/export succeeded with the existing development APNs entitlement. Fixtures don't verify live encrypted approval completion, APNs delivery or physical-device haptic feel after this update.

## Preview 0.1.9 (build 10) — focused inbox

Requests shows pending decisions, at most three recent items, and a Request history link. The separate history list fetches the latest 100 requests only when opened, matching the API's existing limit. Pending and recent inbox queries run concurrently with catalog requests, and the inbox appears before catalog loading completes. Initial approval waits for catalog readiness. Notification links can fetch requests outside the small preview directly. Native-only presentation/data-loading changes use existing API capabilities, with no Worker deployment.

Tests cover early inbox publication, catalog failure, lazy history, notification lookup and discarding responses after switching vaults, plus bounded home history and access to older activity.

The 40-test simulator run passed. Focused follow-up checks cover the final compact home rows, stable automatic refresh and notification opening at Accessibility Extra Large text in dark appearance. Device archive/export retains the existing app identity and development APNs entitlement. Actual phone loading time still depends on vault/network latency; the tests verify the loading dependency and bounded history behavior rather than claiming a measured device speedup.

## Preview 0.1.10 (build 11) — Home Screen icon badge

The iOS app icon shows the last confirmed number of unexpired pending access requests. A successful inbox refresh sets the icon badge with UNUserNotificationCenter (zero removes it); opening or locking the app alone does not clear it. Existing iOS notification permission includes badges, and system badge settings are respected. The Requests tab uses the same server total, including counts beyond the list's 100-item limit. Older vaults can still fall back to their returned pending list until updated.

Native pushes now carry the absolute pending total. Approval and denial send badge-only updates to registered phones without a second alert or sound; those updates run in the Worker execution context so they don't delay a decision response. A Durable Object alarm sends a badge refresh at the next pending request expiry and reschedules for the next one. APNs delivery remains subject to network and iOS delivery; a successful foreground refresh reconciles the count. No secret values are included in the badge payload. The same Worker paths cover decisions made through native, PWA and CLI flows. This private preview requires the updated Worker as well as the app; release tags/main-only rules remain unchanged.

Badge validation: all 22 Worker tests and 27 native unit tests passed. Worker tests verify absolute alert badge counts, badge-only zero clearing, denial updates, expiry alarms and omission of expired requests from the count. Native tests verify the server total can exceed the returned list size. The signed device archive/export retains the same bundle identity and development APNs entitlement. Actual Home Screen rendering/delivery on the owner's iPhone requires the updated app and iOS Badges permission.
