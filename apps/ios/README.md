# Sickrat for iOS — development preview

Native Swift 6 / SwiftUI, iOS 18+, built with Xcode 26. No web view shell or third-party iOS packages.

## Build and test

Install Xcode and XcodeGen. From this folder:

```sh
xcodegen generate
xcodebuild -project Sickrat.xcodeproj -scheme Sickrat -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
./scripts/build-ipa.sh
```

The unsigned development IPA is `build/Sickrat-<version>-<build>.ipa`. AltStore Classic signs it with the installing user's identity. The current preview requests the development APNs entitlement; associated-domain and shared-Keychain entitlements are not requested. The app needs a device passcode for key storage.

This branch's private AltStore installation is a development preview, not a tagged release. Production releases must still originate from `origin/main`. No release tags or release workflow guards are changed.

## First use with an existing vault

1. Install **Sickrat Preview** from the private AltStore source while connected to the Tailnet.
2. Enter the HTTPS origin of your existing vault.
3. Go to Settings → Transfer vault key → Start encrypted transfer. Copy/share the public transfer request.
4. Open the updated PWA's Settings → Native iOS transfer. Paste that request and choose **Unlock and export encrypted transfer**. Approve the fresh passkey ceremony.
5. Save/share the encrypted JSON file to Files on the iPhone. In Sickrat, choose **Import encrypted file** within ten minutes.
6. Use Requests to review and approve CLI requests. The app locks on background; use Unlock to authenticate with Face ID/device passcode.

Keep the existing PWA passkey recovery record. The native app deliberately does not overwrite an existing Keychain root key, export plaintext keys, or create a replacement key for a populated vault. Transfer requests contain public information only; their private keys remain in app memory until import or process exit. An app termination during transfer requires starting a new transfer.

## Implemented

- Requests, Vault, Settings: system lists/forms, tabs, navigation, search, sheets, destructive confirmations, Dynamic Type and VoiceOver labels.
- URLSession API client with HTTPS-only origins, ephemeral caching, timeouts and redirects rejected.
- Keychain storage with user-presence access control and `WhenPasscodeSetThisDeviceOnly`; in-memory key cleared on background. Revealed/entered secrets cleared when backgrounded.
- Secret inspection, encryption, creation, editing, generation; missing secrets can be created atomically with approval.
- Secret, OAuth-token and browser-session grant encryption compatible with the existing CLI.
- OAuth account connection via `ASWebAuthenticationSession`, PKCE, encrypted callback handoff, scope checks and encrypted refresh-token rotation.
- Account inspection/revocation; device review/pairing/revocation; browser-session inspection/revocation.
- PWA-to-native encrypted vault-key transfer with recipient binding, encrypted origin binding, ten-minute expiry, and a fresh passkey ceremony.

## Remaining migration work / intentional exceptions

- **Background push:** approval alerts use native APNs when configured, alongside existing PWA push. Pairing alerts still use the PWA; the native app can review devices while open. The owner confirmed enrollment and background delivery on the direct signed 0.1.7 preview using a paid-team development profile. Pairing alerts still need native support.
- **Provisioning and deployment:** use the CLI/web console to create/update Cloudflare infrastructure. This preview connects to existing vaults.
- **Cloudflare Access:** redirects are intentionally rejected. Interactive Access-protected endpoints need a separate native authentication design; do not paste Access tokens into the app.
- **Recovery/export:** existing PWA retains recovery duties. Native key removal and key replacement are intentionally absent from the preview to avoid stranding existing encrypted records.
- **CLI root-key parity exception:** CLI devices must never receive a vault root key. Root-key transfer is available only in unlocked owner clients; ordinary CLI resource management and grant envelopes remain unchanged.
- Passkey reuse in native apps needs associated domains tied to the signed app identity. This personal AltStore preview uses explicit encrypted transfer and device Keychain authentication instead.

## Validation and limits

XCTest checks Web Crypto AES-GCM ciphertext, ECDH/HKDF parity, tamper rejection, wrong-recipient rejection, HTTPS origin validation and JWK metadata decoding. Worker/Vitest tests verify encrypted transfer and the existing backend. Simulator builds and the device Release build are checked. Actual Face ID, AltStore installation, provider consent and end-to-end grants with the owner's vault key still require on-device testing; these are not claimed as verified.

## Transfer-screen deployment

The development helper `node apps/ios/scripts/deploy-transfer-preview.mjs --dry-run` (from the repo root) uses the existing CLI local-artifact path and a temporary, clearly marked preview version. Build with `npm run web:build` first. After owner approval, pass `--yes`. It reuses the CLI's deployment lock, D1/R2 migration checks and existing VAPID keys. It does not change the production release resolver or generate tags. A later normal `sickrat vault update` returns the vault to a published release, which may remove the experimental transfer screen.

After building and committing a preview, publish it to an existing private source:

```sh
node scripts/publish-preview.mjs /path/to/existing/altstore https://your-private-server/altstore
```

The publisher backs up and atomically replaces `source.json`, preserves other apps, verifies built bundle metadata, includes a checksum and source commit, and refuses to overwrite an existing app version. Increment `CURRENT_PROJECT_VERSION` for the next preview; the package filename is derived from the built app metadata.

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
