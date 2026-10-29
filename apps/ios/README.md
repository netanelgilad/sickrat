# Sickrat for iOS — development preview

Native Swift 6 / SwiftUI, iOS 18+, built with Xcode 26. No web view shell or third-party iOS packages.

## Build and test

Install Xcode and XcodeGen. From this folder:

```sh
xcodegen generate
xcodebuild -project Sickrat.xcodeproj -scheme Sickrat -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
./scripts/build-ipa.sh
```

The unsigned development IPA is `build/Sickrat-0.1.0-1.ipa`. AltStore Classic signs it with the installing user's identity. No associated-domain, APNs, or shared-Keychain entitlements are requested. The app needs a device passcode for key storage.

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

- **Background push:** existing PWA push remains available. This preview polls only while active. Native APNs requires a suitable provisioning identity/entitlement and a Worker APNs delivery path; do not represent foreground polling or local notifications as background delivery.
- **Provisioning and deployment:** use the CLI/web console to create/update Cloudflare infrastructure. This preview connects to existing vaults.
- **OAuth rename/reauthorization/provider configuration editing:** existing CLI/PWA flows remain available; native initial connection and missing-client-ID setup work, but those management screens still need migration.
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

The publisher backs up and atomically replaces `source.json`, preserves other apps, verifies built bundle metadata, includes a checksum and source commit, and refuses to overwrite an existing app version. Increment `CURRENT_PROJECT_VERSION` and the IPA build script filename for the next preview.
