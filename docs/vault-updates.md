# Vault Updates And Migrations

## Goal

Sickrat vaults are deployed into each user's Cloudflare account. After a vault is created, the project cannot push code or schema changes into that vault from a central service. Updates must be owner-initiated, repeatable, and recoverable through the CLI.

The update system should handle:

- updating the local `sickrat` CLI binary
- updating the user-owned Worker/PWA artifact
- applying D1 schema migrations
- applying Durable Object migration metadata
- creating newly required Cloudflare resources
- updating existing bindings, vars, and secrets
- pruning old resources only when Sickrat can prove ownership
- resuming safely after partial failure

Keep the product surface small. Users and agents should not need feature-specific maintenance commands for every resource type.

## Product Surface

Recommended commands:

```sh
sickrat update
sickrat self update
sickrat vault status [name]
sickrat vault update [name] [--dry-run] [--yes] [--resume] [--force-unlock]
```

`sickrat update` is the happy path. It updates the CLI first, then updates the selected/default vault.

`sickrat self update` only updates the local binary.

`sickrat vault update` only updates the user-owned Cloudflare vault resources.

`sickrat vault status` shows the current local and remote versions, health, resources, last completed migration, and whether an update is available.

Avoid one-off public commands such as `update-d1`, `repair-worker`, or `migrate-do`. Those can exist as internal migration steps, but the user-facing model should be one vault update flow.

## Version And Manifest Model

Each vault should have a deployment manifest. Store it in two places:

- remote source of truth in D1
- local cache in `~/.sickrat/config.json`

The remote D1 manifest wins because vaults may be updated from another machine.

Suggested D1 table:

```sql
CREATE TABLE IF NOT EXISTS sickrat_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Suggested manifest value under key `deployment_manifest`:

```json
{
  "manifestVersion": 1,
  "vaultName": "default",
  "sickratVersion": "0.1.11",
  "artifactVersion": "0.1.11",
  "schemaVersion": 3,
  "workerScriptName": "sickrat-default",
  "resources": {
    "d1": {
      "databaseName": "sickrat-default-vault",
      "databaseId": "..."
    },
    "worker": {
      "scriptName": "sickrat-default",
      "workersDevUrl": "https://sickrat-default.example.workers.dev"
    },
    "durableObjects": [
      {
        "binding": "APPROVAL_HUB",
        "className": "ApprovalHub"
      }
    ],
    "assets": {
      "binding": "ASSETS"
    },
    "vars": [
      "SICKRAT_VERSION",
      "VAPID_PUBLIC_KEY"
    ],
    "secrets": [
      "VAPID_PRIVATE_KEY"
    ]
  },
  "migrationsApplied": [
    "0001_initial",
    "0002_push_subscriptions",
    "0003_devices_and_grants"
  ],
  "lastUpdate": {
    "startedAt": "2026-06-13T12:00:00.000Z",
    "finishedAt": "2026-06-13T12:00:08.000Z",
    "fromVersion": "0.1.10",
    "toVersion": "0.1.11"
  }
}
```

The manifest must list only resources Sickrat owns. Pruning decisions must use this manifest, not resource names alone.

## Release Artifacts

Each GitHub release should publish:

- compiled CLI binaries
- `sickrat-web-dist.tar.gz`
- `SHA256SUMS`
- optional future signature material
- machine-readable release metadata

The CLI must verify release artifacts before use:

1. Download release metadata.
2. Download the target binary or web artifact.
3. Download `SHA256SUMS`.
4. Verify the artifact checksum.
5. Only then install or deploy.

Future signing can layer on top of checksums. The docs and skill should describe checksum verification now and signature verification once implemented.

## CLI Self Update

`sickrat self update` should:

1. Determine the current CLI version.
2. Query the latest compatible release.
3. Download the platform-specific binary to a temp path.
4. Verify checksum.
5. `chmod +x` the temp binary.
6. Run the temp binary with `--version`.
7. Atomically replace the current binary when possible.
8. Keep a backup of the previous binary until the new one is verified.
9. Restore the backup if verification fails after replacement.

If the current binary path is not writable, print the exact install command for the detected install method where possible. Do not silently use elevated permissions.

The command should be explicit about what it is doing:

```text
Current CLI: 0.1.11
Latest CLI:  0.1.12
Downloading sickrat-darwin-arm64...
Verifying SHA256SUMS...
Replacing /Users/name/.local/bin/sickrat...
Updated Sickrat CLI to 0.1.12.
```

## Vault Update Flow

`sickrat vault update default` should:

1. Load local config.
2. Fetch remote deployment manifest from the vault D1.
3. Query latest compatible release.
4. Download and verify the target `sickrat-web-dist.tar.gz`.
5. Build a migration plan from current manifest to target manifest.
6. Print the plan.
7. Ask for confirmation unless `--yes` is provided.
8. Acquire a remote update lock.
9. Apply migration steps in order.
10. Verify each step.
11. Write the updated remote manifest.
12. Refresh local cache.
13. Release the lock.

Example output:

```text
Sickrat vault update: default

Current vault: 0.1.11
Target vault:  0.1.12

Plan:
  - upload Worker/PWA artifact
  - apply D1 migration 0004_approval_indexes
  - update Worker var SICKRAT_VERSION
  - verify /api/health

Apply update? [y/N]
```

For agent flows, the skill should instruct the agent to show this plan to the user before passing `--yes`.

## Migration Units

Use explicit migration units. Do not infer migrations by diffing arbitrary Cloudflare state.

Suggested shape:

```ts
type VaultMigration = {
  id: string;
  fromVersion: string;
  toVersion: string;
  plan(ctx: MigrationContext): Promise<MigrationStep[]>;
  apply(ctx: MigrationContext): Promise<void>;
  verify(ctx: MigrationContext): Promise<void>;
};
```

Migration categories:

- D1 schema changes
- Worker script and asset uploads
- Durable Object migration metadata
- binding changes
- Worker var and secret changes
- new resource creation
- manifest-owned resource pruning
- repair steps for known historical bad states

Each migration must be idempotent. Re-running after a crash should either no-op or continue safely.

## D1 Migrations

D1 migrations should be tracked in D1, separate from the broader deployment manifest.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS sickrat_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  sickrat_version TEXT NOT NULL
);
```

Rules:

- Use `CREATE TABLE IF NOT EXISTS`.
- Use `CREATE INDEX IF NOT EXISTS`.
- Guard column additions by checking schema first.
- Wrap related changes in transactions where D1 supports the needed statements.
- Record a migration only after it verifies successfully.

## Cloudflare Resource Migrations

Resource operations should be expressed as `ensure` or `remove if owned`:

- ensure D1 database exists
- ensure Worker script exists
- ensure Worker has required bindings
- ensure Durable Object migration metadata is current
- ensure Worker vars/secrets are set
- ensure optional R2/KV resources exist if the target version requires them
- remove obsolete resource only when it appears in the previous manifest as Sickrat-owned

Do not delete anything based on name prefix alone. Users may have manually created resources with similar names.

## Locking, Resume, And Failure Handling

The update command needs a remote lock stored in D1:

```json
{
  "lockId": "uuid",
  "owner": "hostname:pid",
  "startedAt": "2026-06-13T12:00:00.000Z",
  "expiresAt": "2026-06-13T12:15:00.000Z",
  "fromVersion": "0.1.11",
  "toVersion": "0.1.12",
  "lastCompletedStep": "0004_apply_d1_indexes"
}
```

Behavior:

- If no lock exists, create one before mutating resources.
- If a live lock exists, stop with a clear message.
- If an expired lock exists, offer `--resume` or `--force-unlock`.
- Update `lastCompletedStep` after each verified step.
- On retry, skip verified completed steps.
- Always print created or changed resource ids before returning an error.

Failure output should explain the failed layer, not just raw API errors:

```text
Worker deployment failed while applying Durable Object migration metadata.
Cloudflare response: ...

The update lock is still present so this can be resumed.
Run:
  sickrat vault update default --resume
```

## PWA Update UX

The PWA should not pretend it can self-update across user-owned Cloudflare deployments.

Recommended UX:

- The PWA embeds its artifact version.
- It checks a public Sickrat release metadata endpoint, for example `https://sickrat.dev/releases/latest.json`.
- If a newer compatible version exists, show a small in-app banner:

```text
Vault update available
Ask your agent to run: sickrat vault update default
```

The banner should not block approvals or secret entry. It should link to the exact CLI command and explain that the vault is owned by the user's Cloudflare account, so updates are applied from the user's CLI.

If the installed service worker has a new local asset version after a successful vault update, the existing PWA reload prompt can still handle refreshing the app shell. That is separate from updating the Cloudflare resources.

## Compatibility Rules

The CLI should know whether it can update a vault directly:

- same major version: apply normal migrations
- older supported major version: apply documented bridge migrations
- unknown future vault version: refuse and ask user to update the CLI
- too old and unsupported: print manual recovery docs

The release metadata should include:

```json
{
  "version": "0.1.12",
  "minUpgradeableVaultVersion": "0.1.8",
  "requiresCliVersion": "0.1.12",
  "artifacts": {
    "web": "sickrat-web-dist.tar.gz"
  },
  "migrations": [
    "0004_approval_indexes"
  ]
}
```

## Minimal Implementation Order

1. Add remote D1 manifest and migration tables during `vault create`.
2. Add `sickrat vault status`.
3. Add release metadata consumption and artifact verification plumbing.
4. Add `sickrat vault update --dry-run`.
5. Add lock acquisition, resume, and status reporting.
6. Add the migration runner with a no-op migration for the current version.
7. Add real Worker/PWA redeploy as the first update operation.
8. Add D1 migration support.
9. Add resource creation/pruning support.
10. Add `sickrat self update`.
11. Add `sickrat update` as the combined happy path.
12. Add PWA update-available banner pointing to the CLI update command.

This order makes the system observable before it becomes destructive.

## Non-Goals For The First Version

- no central service that reaches into user accounts
- no automatic background updates from `sickrat.dev`
- no pruning of resources missing from the manifest
- no separate user-facing commands for each Cloudflare primitive
- no migration that depends on unverified release artifacts
