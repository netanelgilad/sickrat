# Threat Model

## Primary Threats

- A compromised or over-permissioned local agent requests secrets it should not access.
- A remote machine asks for secrets without the user noticing.
- Cloudflare storage is read by an attacker.
- A paired CLI device is stolen or copied.
- Plaintext secrets leak through process environment inspection, shell history, logs, crash reports, or child process behavior.
- OAuth refresh tokens or access tokens are over-broad, stale, or released with scopes the user did not intend.

## Security Goals

- Cloudflare stores ciphertext for vault secrets.
- OAuth refresh tokens are stored as encrypted vault records.
- CLI devices cannot decrypt vault storage directly.
- Every secret access requires mobile approval unless the user explicitly configures a policy later.
- Approval responses are short-lived and single-use.
- Audit events are recorded in the user's own Cloudflare account.
- The approval UI shows enough context to make a real decision.

## Non-Goals For V1

- Preventing a malicious approved process from exfiltrating a secret after it receives it.
- Protecting against a fully compromised mobile device.
- Enterprise multi-user administration.
- Central hosted recovery.

## Approval UI Must Show

- requesting device
- host name
- command
- working directory
- requested secret refs
- requested OAuth provider, account, and scopes
- timestamp
- location or IP signal if available
- previous approval history for this device/ref if useful

## OAuth Token Exchange

OAuth refresh can require the user-owned Worker to act as a transient token-exchange proxy because provider token endpoints often require a client secret or block browser CORS. In that mode, the PWA decrypts the refresh token only after passkey unlock and approval intent, sends it to the user's Worker over HTTPS, and the Worker exchanges it without persisting plaintext token material.

This is a weaker property than static secret approval, where the Worker does not need to see plaintext. Provider connections should record whether refresh is PWA-direct or Worker-assisted, and the approval UI should make scope breadth and account identity visible before release.

## Local Machine Risks

Environment variables are not a hard security boundary. V1 supports env injection because it is the compatibility path most agent tools can use, but the product should clearly support safer delivery channels over time.

## Cloudflare Compromise Or Misconfiguration

If Cloudflare storage is exposed, the attacker should see:

- encrypted secret records
- device metadata
- audit metadata
- pending approval metadata

They should not be able to decrypt vault secrets without the mobile-held vault key or an approved encrypted response.

## Device Revocation

Revoking a CLI device should:

- mark the device revoked in D1
- reject new approval requests
- leave old audit records intact
- optionally rotate vault or wrapping keys if compromise is suspected
