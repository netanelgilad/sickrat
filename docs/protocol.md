# Protocol

## Identities

### User

Authenticated through Cloudflare. The user owns the Cloudflare account and all backend resources.

### Mobile Device

Trusted approval device. Stores or unlocks the vault root key using the platform secure store.

### CLI Device

Paired machine or agent host. Has a device id and device keypair, but never has the vault root key.

## Pairing

Pairing establishes trust between a CLI installation and the user's mobile app.

Suggested first version:

1. CLI generates a device keypair.
2. CLI displays a QR code containing device public key, nonce, and Worker endpoint.
3. Mobile scans QR code.
4. Mobile signs or approves the pairing request.
5. Worker records the paired device.

## Secret Record Encryption

Each secret field is encrypted before upload.

```text
plaintext secret
  encrypted by field data key
field data key
  wrapped by vault key
vault key
  stored only on mobile / user-controlled recovery mechanism
```

This leaves room for rotation and sharing later without changing the storage format.

## Approval Request

Legacy secret-only requests use `refs`. The OAuth gateway uses typed resource requests while keeping `refs` for older CLIs.

```json
{
  "request_id": "apr_...",
  "device_id": "dev_...",
  "host": "mac-mini.local",
  "cwd": "/repo",
  "command": ["npm", "test"],
  "refs": [
    "openai/api-key"
  ],
  "request_public_key": "base64...",
  "created_at": "2026-06-06T00:00:00Z",
  "expires_at": "2026-06-06T00:01:00Z"
}
```

Typed requests can mix static secrets and OAuth access tokens:

```json
{
  "request_id": "apr_...",
  "device_id": "dev_...",
  "command": ["npm", "run", "inspect-repo"],
  "resource_requests": [
    { "type": "secret", "ref": "openai/api-key" },
    {
	  "type": "oauth_token",
	  "provider_id": "github",
	  "connection_name": "work",
	  "scopes": ["repo", "read:user"],
      "env": "GITHUB_TOKEN"
    }
  ],
  "request_public_key": "base64...",
  "created_at": "2026-06-26T00:00:00Z",
  "expires_at": "2026-06-26T00:01:00Z"
}
```

## Approval Response

```json
{
  "request_id": "apr_...",
  "status": "approved",
  "encrypted_payload": "base64...",
  "consumed": false
}
```

The encrypted payload contains the resolved secret values and OAuth access tokens, encrypted to the CLI request public key. Refresh tokens are never returned to CLI devices.

## Denial Response

```json
{
  "request_id": "apr_...",
  "status": "denied",
  "reason": "user_denied"
}
```

## Expiry

Approval requests should expire quickly. Initial target:

- 60 seconds pending approval
- 15 seconds after approval for CLI consumption
- single successful consume only

Durable Objects should enforce consumed/expired state server-side.
