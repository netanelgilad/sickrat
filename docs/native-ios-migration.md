# Native iOS migration

Sickrat’s only owner-facing app is now native iOS. The CLI (including its phone-approved MCP server) and Cloudflare Worker API remain. `apps/web` and `sickrat-web-dist.tar.gz` keep their names to preserve the existing CLI updater/artifact contract, but contain only the backend and an iOS link handoff. React, Konsta, web navigation, the PWA manifest, offline console, and web-push delivery are removed.

## Existing PWA vaults

Before deploying this version, install the native app, transfer the **existing** key from your old PWA, verify decryption in iOS, and save a password-encrypted native recovery backup. The new app can export that backup from its existing Keychain key. Do not create a new key for populated vaults. The native app refuses this operation and refuses to overwrite an existing device key.

The retiring service worker unregisters itself and removes only old Workbox precaches. Browser localStorage/passkey records are preserved. Browser-only owners must migrate before updating their Worker; if they updated prematurely, restore a previous published Worker artifact to perform the old transfer flow, then upgrade again. A WebAuthn wrapped passkey record is not a native recovery file. There is no server-held root key to recover on someone’s behalf.

Updating source on main does not update a user-owned vault. Vault deployment remains an explicit CLI operation. Do not deploy the retirement artifact to an owner who has not completed migration.

## Current ownership and parity

- iOS: approval/denial, secret management, OAuth connections and repair, provider configuration, paired-device management, browser-session inspection/revocation, APNs, key creation/transfer/recovery.
- CLI: provisioning/updates, device pairing, provider/connection inspection and metadata management, grant requests, browser-session transactions, and native-notification enrollment/device management with the owner credential.
- MCP: metadata plus explicit phone-approved, bounded, single-use access collection. It is an optional agent interface, not another owner app.
- Browser: public link handoff and encrypted, one-time system OAuth callback only. A custom-scheme link contains public IDs and origin; the native app rejects other-vault links and never auto-approves.

Connection/reauthorization, key transfer and recovery intentionally require the native owner app. The CLI cannot decrypt refresh tokens or root keys. Notification owner setup remains on the Mac; per-device credentials only authorize that device’s token registration. This is not proof of root-key possession. API owner authorization assumptions are unchanged by removing the console; do not describe the system as a hardened multi-user service.

## Compatibility

The existing D1/R2 records and grant envelopes are retained. Legacy web-push APIs return HTTP 410; old tables and VAPID deployment bindings remain for non-destructive upgrades/rollbacks. APNs replaces web-push delivery. Signed requests no longer require any notification registration, so the foreground native inbox works with notifications disabled. The badge counts access requests; device pairing gets a separate generic alert and still requires code review.

Release tags must target commits already on origin/main. Migration does not create a release, bypass the release guard, change a deployed vault automatically, or distribute signing credentials.
