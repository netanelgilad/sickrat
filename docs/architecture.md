# Architecture

## Operating Model

Sickrat is a self-provisioned system. There is no central service account and no shared hosted vault.

Each user authorizes the app with Cloudflare and installs the backend into their own Cloudflare account. All durable resources belong to that account.

```text
User Cloudflare account
  Worker API
  D1 database
  Durable Object namespace
  R2 bucket, optional
  KV namespace, optional
  Worker secrets for operational config only
```

The open-source mobile app and CLI act as clients for that user-owned backend.

## Cloudflare Primitives

- **Workers:** API surface for CLI, mobile, provisioning callbacks, device pairing, and approval polling.
- **Durable Objects:** Pending approval sessions. Durable Objects are a good fit because each request needs coordination, TTL cleanup, one-time consumption, and possibly WebSocket or long-poll state.
- **D1:** Relational metadata: devices, secret records, vaults, audit events, approval history, push registrations.
- **R2:** Optional encrypted blob storage for larger secret payloads, file secrets, attachments, or version history.
- **KV:** Optional cache for non-sensitive config such as provisioning version markers.
- **Worker Secrets / Cloudflare Secrets Store:** Operational secrets for the user's Worker deployment, not vault secret storage.

## Why Vault Secrets Are Not Stored As Worker Secrets

Cloudflare Worker secrets and Secrets Store are designed for infrastructure secrets bound to Workers. They are not a user-facing vault API. Once stored, secrets are not retrievable in a way that supports mobile-mediated decryption and request-specific re-encryption.

Vault secrets should be stored as encrypted records:

```text
secret_record {
  id
  vault_id
  item_name
  field_name
  ciphertext
  nonce
  key_version
  created_at
  updated_at
}
```

Only trusted clients with the user's vault key can decrypt.

## Trust Boundaries

- Cloudflare stores ciphertext and coordinates approval state.
- Mobile owns or unlocks the vault root key.
- CLI owns a device keypair and creates per-request ephemeral keys.
- Worker validates identity, records audit events, and relays encrypted approval envelopes.
- The spawned process receives plaintext only through the selected injection mechanism.

## Approval Flow

1. CLI parses requested references from command args, environment files, or templates.
2. CLI generates a request keypair and sends:
   - device id
   - host metadata
   - command summary
   - working directory
   - requested secret refs
   - ephemeral public key
3. Worker verifies the paired device and creates an approval session.
4. Worker sends a push notification to the registered mobile device.
5. Mobile fetches request details and displays the approval screen.
6. On approval, mobile decrypts the requested values locally.
7. Mobile encrypts a response envelope to the request public key.
8. CLI consumes the envelope once.
9. Durable Object marks the session consumed and expires the state.
10. CLI injects values and spawns the child process.

## Initial Deployment Shape

The mobile app should provide a guided provisioning flow:

1. Login with Cloudflare.
2. Select account.
3. Create or update Worker project.
4. Create D1 database.
5. Create Durable Object namespace.
6. Create optional R2 bucket.
7. Set Worker secrets needed for push/config.
8. Deploy Worker code.
9. Store deployment metadata locally and in the user's Cloudflare resources.

Provisioning needs to be idempotent so mobile and CLI upgrades can migrate resources safely.
