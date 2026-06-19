# Generated Secret Flows

Sickrat should support password-change and new-credential flows without adding provider-specific commands. The product surface should stay centered on `sickrat run`, the approval screen, and normal secret refs.

## Product Shape

Use the existing approval request flow, extended with per-ref intent:

- `existing`: resolve a stored ref and grant it after approval.
- `missing`: ask the user to enter a value, save it encrypted, then grant it.
- `generated`: generate a candidate value in the PWA, save it encrypted on approval, then grant it.

Implemented v1 behavior:

- `sickrat run --env KEY=ref` can request refs that do not exist yet.
- The approval screen marks missing refs as “Needs value”.
- The user can type/paste a value or generate a 22-character password locally.
- Uppercase, lowercase, and digits are included by default; symbols are optional per ref.
- New encrypted secret records are submitted with the approval grant and are stored only when the approval succeeds.
- The CLI still receives the value only through the encrypted grant; it is not printed.

Request-side generation hints and constraints remain a later extension.

Today, a password-change scraper can ask for both the old password and a fresh missing new-password ref in one phone approval:

```sh
sickrat run \
  --env SERVICE_PASSWORD=service/password \
  --env SERVICE_NEW_PASSWORD=service/password/2026-06-19 \
  --message "Service requires a password change; approve the old password and create a replacement." \
  -- npm run rotate-service-password
```

Later, request-side generation constraints could make that intent explicit:

```sh
sickrat run \
  --env SERVICE_PASSWORD=service/password \
  --generate-env SERVICE_NEW_PASSWORD=service/password/2026-06-13 \
  --constraints SERVICE_NEW_PASSWORD.length=18 \
  --constraints SERVICE_NEW_PASSWORD.uppercase=true \
  --constraints SERVICE_NEW_PASSWORD.numbers=true \
  --constraints SERVICE_NEW_PASSWORD.symbols=false \
  --message "Service requires a password change; approve the old password and a generated replacement." \
  -- npm run rotate-service-password
```

The exact future flag syntax can change, but the capability should remain part of `run`. Do not add one-off commands such as `request-generated`, `promote`, or provider-specific password-change commands.

## Why New Refs

Generated values should normally be stored under a new ref, often date- or purpose-scoped:

```text
service/password
service/password/2026-06-13
service/password/next
```

This avoids overwriting the known-good password before the provider accepts the change. The user can later replace or archive the old ref from the PWA, or a future generic commit flow can mark the generated ref as the primary value after the child process confirms success.

Sickrat should not pretend to be transactional across arbitrary websites. The safe baseline is:

1. Grant old password plus generated new password to the child process.
2. Child process changes the provider password.
3. User sees both refs in the vault and can keep, rename, or delete as needed.

Later, Sickrat can add a generic post-run commit signal, but it should still be a refinement of `run`, not a separate provider-specific command.

## Approval Request Data Model

Keep `secretRefs` for compatibility, but add optional request metadata:

```json
{
  "secretRefs": ["service/password", "service/password/2026-06-13"],
  "refRequests": [
    {
      "ref": "service/password",
      "mode": "existing"
    },
    {
      "ref": "service/password/2026-06-13",
      "mode": "generated",
      "label": "New service password",
      "constraints": {
        "length": 18,
        "uppercase": true,
        "lowercase": true,
        "numbers": true,
        "symbols": false,
        "ambiguous": false
      }
    }
  ]
}
```

The Worker does not generate or see plaintext. It stores request metadata and routes the approval to the PWA.

## PWA Behavior

For missing/generated refs, the approval screen should:

- show the ref clearly as a value that will be created and granted;
- let the user type or paste a value;
- generate/regenerate a candidate locally in the PWA;
- allow reveal/copy only with an explicit tap;
- save the value encrypted into D1 only when the user approves;
- include the plaintext value only inside the encrypted grant sent to the CLI.

If the generated ref already exists, the approval screen should not silently overwrite it. It should show an explicit choice:

- use existing value;
- generate a new version under a different ref;
- replace this ref.

Default should be non-destructive.

## CLI Behavior

`sickrat run` remains the primary interface.

Potential syntax:

```sh
sickrat run \
  --env OLD_PASSWORD=service/password \
  --generate-env NEW_PASSWORD=service/password/next \
  --constraints NEW_PASSWORD.length=18 \
  --constraints NEW_PASSWORD.symbols=false \
  -- npm run rotate-password
```

Rules:

- `--env KEY=ref` means stored or just-in-time user-entered value.
- `--generate-env KEY=ref` means generated value requested for that env key.
- constraints are attached to the generated env key, not globally.
- generated values are never printed.
- the child process receives both ordinary env-file values and approved/generated secret env values.

Env-file support can use a minimal marker later:

```env
OLD_PASSWORD=sickrat://service/password
NEW_PASSWORD=sickrat+generate://service/password/next?length=18&symbols=false
```

Do not add env-file generation markers until the flag form is working and stable.

## Password Constraints

Use a small generic constraint object:

```ts
type GeneratedSecretConstraints = {
  length?: number;
  minLength?: number;
  maxLength?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  numbers?: boolean;
  symbols?: boolean;
  ambiguous?: boolean;
  allowedSymbols?: string;
  disallowedCharacters?: string;
};
```

The generator should use Web Crypto randomness in the PWA. It should validate the final candidate against the requested constraints before saving or granting it.

Provider-specific presets can come later, but they should be aliases for constraints, not special flows:

```sh
--preset service-name
```

## Audit And UX

Approval history should record that a generated value was approved without recording the plaintext:

```text
Generated service/password/2026-06-13
length 18, uppercase, lowercase, numbers, no symbols
granted to mac-mini.local for npm run rotate-password
```

The user-facing copy should describe this as "Generate and approve a new secret" rather than "password reset automation." Sickrat should provide the credential safely; the child process owns the provider-specific change flow.

## Open Decisions

- Whether generated refs should default to `/next`, date suffixes, or whatever the agent chooses.
- Whether `run` should support a post-run success marker that promotes or labels the generated ref.
- Whether replacement of an existing ref should require a second confirmation.
- Whether generated values should be visible in the PWA after approval or hidden by default like normal secrets.
