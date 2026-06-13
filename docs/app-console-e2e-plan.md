# Sickrat App Console E2E Plan

This is the implementation handoff for turning `/app` into a real management console instead of a setup panel page. The next run should implement this end-to-end, not as a phased mock. Use subagents for parallel slices, but integrate into one deployed product.

## Current State

- Public site: `https://sickrat.dev`.
- Web app: `apps/web`.
- Worker/API: `apps/web/src/worker/index.ts`.
- PWA service worker: `apps/web/src/sw.ts`.
- React app: `apps/web/src/main.tsx`.
- Styles: `apps/web/src/styles.css`.
- Router is already installed and active with:
  - `/`
  - `/app`
  - `/cf/callback`
  - `/approve/:requestId`
  - `/secrets`
  - `/pair`
- `/` is product/landing only.
- `/app` is the private console, but still too shallow.
- Approval push/realtime URLs now use `/approve/:id`.
- Existing deployed Worker version after React Router conversion: `0bc87d33-a6a1-48af-a8d0-4d415a148f5b`.
- Public GitHub repo: `https://github.com/netanelgilad/sickrat`.

## Product Goal

Build Sickrat as a real owner console:

- Public landing page sells the product.
- `/app` is a proper logged-in/owner management application.
- The app lets a user manage vault setup, secrets, approvals, devices, push/install, and Cloudflare-owned resources.
- It should feel like a Quarantine Console: operational, security-focused, serious, and not templated.
- It must preserve the core security story: users own their Cloudflare resources; Sickrat is open-source; no hosted multi-tenant secret ownership.

## Non-Negotiables

- Do not mock backend data when a real API can be built.
- Do not remove working flows:
  - Cloudflare OAuth login.
  - Create Vault / provisioning prototype.
  - Passkey-protected local vault key.
  - Add encrypted secrets.
  - Just-in-time missing secret creation during approval.
  - Pair CLI.
  - Enable push / send test.
  - Realtime foreground approval navigation.
  - Web Push approval navigation.
  - Approve/deny request flow.
- No query-param based app routing.
- Keep `/approve/:requestId`, `/secrets`, `/pair`, `/cf/callback` working.
- Use real Cloudflare Worker/D1 data.
- Keep the app deployable to Cloudflare Workers.

## Target Route Map

Public:

```text
/                         Landing page
/skills/sickrat.md        Public agent skill file
```

App:

```text
/app                      Dashboard
/app/vaults               Vault/resource management
/app/secrets              Secret refs list and create/edit
/app/approvals            Approval history and pending requests
/app/approvals/:id        Approval detail/history view
/app/devices              Paired devices and pairing entry
/app/settings             Cloudflare, install/PWA, push, vault key
```

Task routes:

```text
/approve/:requestId       Focused mobile approval flow
/secrets                  Compatibility redirect to /app/secrets or focused secret-entry route
/pair                     Compatibility redirect to /app/devices or focused pair route
/cf/callback              OAuth callback, then redirect to /app/settings or /app
```

Recommendation:

- Keep `/approve/:requestId` focused and full-screen.
- Move normal secret entry and pairing UI into `/app/secrets` and `/app/devices`.
- Use `/secrets` and `/pair` as redirects or compatibility shells only if needed.

## App Shell Requirements

Build a persistent console shell for all `/app/*` routes:

- Desktop: left sidebar.
- Mobile: top bar plus bottom nav or drawer.
- Header/top status row:
  - active vault label/name.
  - Cloudflare session status.
  - push status.
  - install/PWA status.
  - vault key lock/unlock state.
- Main content area uses route outlet and route transitions.
- Sidebar items:
  - Dashboard
  - Vaults
  - Secrets
  - Approvals
  - Devices
  - Settings
- Make active route visually obvious.

Suggested implementation:

- Refactor `apps/web/src/main.tsx` into route components, still in one file if faster, or split under `apps/web/src/components` / `apps/web/src/routes`.
- Prefer components with clear names:
  - `AppShell`
  - `LandingPage`
  - `DashboardRoute`
  - `VaultsRoute`
  - `SecretsRoute`
  - `ApprovalsRoute`
  - `ApprovalDetailRoute`
  - `DevicesRoute`
  - `SettingsRoute`
  - `FocusedApprovalRoute`
  - `InstallPrompt`
- Keep shared state where it is practical. Do not over-architect global state yet.

## Dashboard

The dashboard should answer: "Is my Sickrat vault ready, and what needs attention?"

Cards:

- Vault status:
  - Cloudflare connected or not.
  - resources created or not.
  - current account if available.
- Secrets:
  - count.
  - quick link to add ref.
- Pending approvals:
  - latest pending requests.
  - link to approval detail.
- Devices:
  - count.
  - quick pair action.
- Install/push health:
  - installed PWA or browser tab.
  - push enabled/ready/offline.

## Vaults Route

Today the actual product is one vault per deployed Worker, but the UX should prepare for multiple vaults.

Implement now with real current data:

- Current vault card:
  - name/slug if available, otherwise `default`.
  - deployed origin.
  - D1 configured yes/no.
  - Durable Object configured yes/no if detectable.
  - Cloudflare session state.
- Cloudflare login/create vault controls moved here or in Settings, but Dashboard can link here.
- Resource creation status should show step-by-step provisioning result, reusing current `provisioning.steps`.

Future-ready copy:

- "Vaults are Cloudflare-owned Sickrat deployments. This prototype manages the current deployed vault first."

Do not invent fake vault lists. If real multi-vault API does not exist yet, show a single current-vault resource card.

## Secrets Route

Replace focused `/secrets` as the main secret management page.

Requirements:

- Show stored refs from `GET /api/secrets`.
- Search/filter refs client-side.
- Add secret form:
  - label.
  - reference.
  - secret value.
  - passkey vault key create/unlock affordance if needed.
- Show encryption state:
  - "value encrypted locally before upload."
  - no plaintext reveal by default.
- Show just-in-time note:
  - "Agents can request missing refs; you can create them during approval."
- Empty state should be useful.

Optional if quick:

- Edit existing secret by reusing the same `POST /api/secrets` upsert.

## Approvals Route

This needs new real Worker APIs.

Add APIs:

```http
GET /api/approvals?limit=100&status=pending|approved|denied
GET /api/approvals/:id
```

Existing:

```http
GET /api/approvals/:id
POST /api/approvals/:id/approve
POST /api/approvals/:id/deny
GET /api/approvals/:id/grant
POST /api/approvals/:id/grant
```

Implementation detail:

- There is already an `approvalSelect` SQL snippet and `mapApproval`.
- Add list endpoint using D1:
  - order by `created_at DESC`.
  - limit capped to 100.
  - optional status filter.
- Return:

```ts
{ approvals: ApprovalRequest[] }
```

Approvals UI:

- Tabs or segmented control:
  - Pending
  - Approved
  - Denied
  - All
- Table/list:
  - status.
  - device.
  - command.
  - message.
  - refs count.
  - created time.
  - decided time.
- Click opens `/app/approvals/:id`.

Approval detail:

- Same metadata as focused approval.
- For pending requests, link/button to `/approve/:id` for actual approval action.
- For decided requests, show read-only history.

## Devices Route

This needs new real Worker APIs.

Add APIs:

```http
GET /api/devices
POST /api/devices/:id/revoke
```

Data exists in `devices` table:

- `id`
- `label`
- `public_key`
- `created_at`
- `revoked_at`

Return:

```ts
{
  devices: Array<{
    id: string;
    label: string;
    createdAt: string;
    revokedAt: string | null;
  }>
}
```

Do not expose full public keys in the default UI unless useful. Device id and label are enough.

Devices UI:

- List paired devices.
- Show active/revoked.
- Pair new device form:
  - Move existing six-digit code loader/approval here.
- Revoke button:
  - calls real revoke endpoint.
  - confirm in UI before revoking if simple.
- Empty state:
  - instructions to run `sickrat pair <your-vault-url>`.

## Settings Route

Settings should own setup/infrastructure concerns:

- Cloudflare account:
  - login/logout.
  - selected account.
  - create vault resources.
  - provisioning steps/errors.
- PWA install:
  - Android/Chromium: native install button using `beforeinstallprompt`.
  - iOS Safari: manual instructions for Share -> Add to Home Screen.
  - iOS non-Safari: tell user to open in Safari.
  - installed mode: show "Installed".
- Push approvals:
  - enable push.
  - send test.
  - status.
- Vault key:
  - create passkey.
  - unlock passkey.
  - reset local key warning.

## PWA Install Prompt Component

Implement real install behavior.

State:

- `isStandalone()` already exists.
- Need iOS detection:

```ts
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || 
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
```

- Need Safari-ish detection for iOS guidance.
- Need `beforeinstallprompt` event:

```ts
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};
```

Behavior:

- Listen once in a component:
  - `window.addEventListener("beforeinstallprompt", handler)`.
  - `event.preventDefault()`.
  - store event.
- If event exists and not standalone:
  - show `Install Sickrat` button.
  - call `event.prompt()`.
  - await `userChoice`.
- If iOS and not standalone:
  - show custom instruction card:
    - "Open this page in Safari."
    - "Tap Share."
    - "Tap Add to Home Screen."
    - "Open Sickrat from the new icon to enable push approvals."
- If standalone:
  - show installed status.

Where to place:

- Dashboard health card.
- Settings PWA section.

## Worker/API Implementation Details

Use existing `ensureSchema`.

Add map helper:

```ts
function mapDevice(row: DeviceRecord) {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
```

Add route before generic `/api/approvals/:id` handlers:

```ts
if (url.pathname === "/api/approvals" && request.method === "GET") { ... }
```

Careful ordering:

- `/api/approvals` list must be checked before `/api/approvals/...`.
- `/api/devices` list before pairing-code routes is okay because pairing-code routes are `/api/devices/pairing-codes/...`.
- `/api/devices/:id/revoke` must not catch `/api/devices/pairing-codes/...`.

Revoke:

```sql
UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
```

Return updated device or ok.

## Frontend API Additions

Add to `api` object:

```ts
async listApprovals(status?: ApprovalRequest["status"] | "all") {}
async listDevices() {}
async revokeDevice(id: string) {}
```

Add types:

```ts
type Device = {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
};
```

## State/Data Loading

Do not introduce a large data framework yet.

Simple approach:

- Keep global state in top-level route shell for:
  - capabilities.
  - secrets.
  - subscription.
  - Cloudflare token/accounts/provisioning.
  - vault key state.
- Add state for:
  - approvals list.
  - devices list.
- Add refresh functions:
  - `refreshSecrets`.
  - `refreshApprovals`.
  - `refreshDevices`.
- Call refresh on route mount / after actions.

If splitting components, pass actions as props.

## Copy Requirements

Use product language, not implementation dump:

- "Vault runs in your Cloudflare account."
- "Sickrat does not operate a hosted secret vault."
- "Approve a grant, not a permanent credential."
- "Agents can request missing refs; you create them at approval time."
- "Install the PWA to receive phone approvals."

Avoid:

- Overpromising exact TTL until backend enforces expiry.
- Saying Face ID unless talking about passkey/platform unlock broadly.
- Saying Sickrat stores plaintext.

## Validation Checklist

Local:

```sh
npm --workspace apps/web run typecheck
npm --workspace apps/web run build
```

Route smoke after deploy:

```sh
for route_path in / /app /app/vaults /app/secrets /app/approvals /app/devices /app/settings /approve/smoke /cf/callback; do
  curl -sS -o /tmp/sickrat-route.html -w "%{http_code}" "https://sickrat.dev$route_path"
done
```

API smoke:

```sh
curl -sS https://sickrat.dev/api/capabilities
curl -sS https://sickrat.dev/api/approvals
curl -sS https://sickrat.dev/api/devices
```

Manual checks:

- `/` has no vault management panels.
- `/app` dashboard renders.
- `/app/secrets` can create/unlock passkey and add a secret.
- `/app/devices` can load/pair and list devices.
- `/app/approvals` shows test approval after Send Test.
- Notification click opens `/approve/:id`.
- Foreground realtime opens `/approve/:id`.
- iOS install guidance appears when not standalone.
- Push enable/test remains available.

Known test gap:

- `npm --workspace apps/web test -- --run` currently fails due existing Cloudflare Vitest/Wrangler `assets.directory` config issue.

## Suggested Subagent Split

Use parallel subagents with disjoint write scopes:

1. Worker/API worker:
   - Owns `apps/web/src/worker/index.ts`.
   - Adds approvals list, devices list, revoke endpoint.
   - No UI changes.

2. App shell/routes worker:
   - Owns route/component structure in `apps/web/src/main.tsx`.
   - Creates nested `/app/*` routes and sidebar shell.
   - No Worker API changes.

3. App UI/styles worker:
   - Owns `apps/web/src/styles.css` and maybe component class names in coordination.
   - Builds responsive sidebar/mobile nav and Quarantine Console polish.
   - No Worker API changes.

4. PWA install/settings worker:
   - Owns install prompt component and Settings page wiring.
   - May touch `main.tsx` and `styles.css`; coordinate with route worker or do after route worker lands.

Parent integration:

- Review all diffs.
- Resolve route/component conflicts.
- Run typecheck/build.
- Deploy with:

```sh
PATH="$HOME/.bun/bin:$PATH" npm --workspace apps/web run deploy
```

- Push to GitHub.

## Done Definition

- `/app` feels like a real management console, not a marketing appendage.
- The user can navigate through Dashboard, Vaults, Secrets, Approvals, Devices, Settings.
- Approvals and devices are backed by real D1 APIs.
- PWA install guidance is implemented for iOS and native install prompt for supported Android/Chromium browsers.
- Existing approval, secret, push, pairing, and Cloudflare login flows still work.
- Deployed to `https://sickrat.dev`.
- Changes committed and pushed to `main`.
