# Native product and interaction direction

Reviewed 31 October 2026. This is an implementation brief based on the current product, the owner's feedback and public prior art. It is not a claim of usability research with other users.

## The job

Sickrat is the owner's decision point for agent access. The primary question is: **Should this device get this access for this purpose and duration?** A successful everyday visit is short: open an alert, understand the request, decide, know the result. Vault maintenance and setup are secondary jobs.

Keep three stable destinations: Requests (decide), Vault (find and manage access resources), Settings (devices, alerts and security). Don't add a dashboard of activity counts that competes with a pending decision. Don't label an idle inbox as proof that the vault is secure.

## Evidence and access limits

- The supplied [shared conversation](https://chatgpt.com/share/6ae5eaf7-1bd8-83ed-ad29-67fae1913cf5?ogimg=plain) rendered the questions about free Mobbin alternatives and mobile apps; its assistant answers were blank/unavailable in the retrieved page. No recommendations from those missing answers are assumed.
- [Mobbin MCP](https://mobbin.com/mcp) is available on paid Pro/Team plans. Plugin discovery did not return a Mobbin connector. No paid account was created and no MCP connection is claimed.
- [ScreensDesign MCP](https://screensdesign.com/mcp/) also requires Pro authorization. Its public [1Password entry](https://screensdesign.com/apps/1password-password-manager/?id=1029) was browsed; the chapters describe setup, unlock, item management, vaults and settings. Public previews are limited. We did not inspect its protected recording or treat commercial revenue estimates as evidence of usability.
- [Duo's official iOS guide](https://guide.duo.com/iphone), including its actual approval screenshot: identity and context precede a deliberate approve/deny decision. Apply the hierarchy, not Duo's branding or its different authentication protocol.
- [Apple Passwords screenshots and instructions](https://support.apple.com/en-gb/104955): recognizable resource categories, a calm hierarchy, explicit item details, system authentication. Apply discoverable resource groups; don't claim Sickrat has Passwords' sync/recovery capabilities.
- [1Password's official iOS guide and screenshot](https://support.1password.com/getting-started-ios/): search, categorized items, an obvious creation action, and editing from item detail. Apply those navigation patterns without adding unrelated password-manager features.
- Apple HIG: [feedback](https://developer.apple.com/design/human-interface-guidelines/feedback), [motion](https://developer.apple.com/design/human-interface-guidelines/motion), [loading](https://developer.apple.com/design/human-interface-guidelines/loading), and [progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators). Motion should explain results, preserve context and respect accessibility settings.

No third-party artwork, screenshots or brand assets are shipped in the app.

## Screen contracts

| Screen | What the person needs | Implementation |
| --- | --- | --- |
| Requests | What needs a decision now? | Pending requests precede history. Recognizable symbols, readable device names, purpose, resource count and duration. Idle state stays compact beside history. |
| Review request | Who, why, what, how long? | Requester and purpose first, requested resources next, duration and response deadline explicit. Command remains inspectable in a disclosure. Approve and Deny stay in the safe area while details scroll. Existing explicit approval confirmation and fresh request validation remain. |
| Completed decision | Did it work? What happened? | A receipt appears only after the operation succeeds. It names the device and duration, uses a brief symbol bounce and success haptic, and lets the person leave with Done immediately. No forced wait or automatic dismissal. Denial doesn't imply prior grants were revoked. |
| Vault | Where is the thing I need? | Accounts and sessions are reachable above a long secret list. Counts refer to non-revoked records only and aren't invented during first load. Secrets sort by name, show their reference and have search, an actionable first-use state and a distinct no-results state. |
| Secret | What is it, and can I inspect or edit it? | A readable update date, explicit reveal, contextual Edit in the toolbar. Existing lock/background clearing stays in place. No automatic clipboard export. |
| Settings | Can I manage this phone and vault? | Identify the vault, then alerts/devices, then lock/transfer/recovery explanation. Move version information into a quiet footer. |
| Notifications | What is the benefit and next step? | Explain access alerts before enabling. During pairing show the code, a native share action and permission steps. Waiting is local to notification setup; it doesn't disable navigation or sharing for ten minutes. Preserve the existing credential and background retry behavior. |
| Connect and key transfer | How do I join my existing vault safely? | Existing HTTPS validation and encrypted transfer remain. Guided transfer and notification onboarding can be refined further after this pass; don't claim a key transfer is a backup. |

## Motion and accessibility

- Use the system navigation, sheets, buttons and tab behavior.
- Zoom from a secret's icon into its detail with iOS 18's native navigation transition; use ordinary navigation when Reduce Motion is enabled.
- Replace the lock symbol in place and give a success haptic on successful unlocking. Do not move the toolbar control.
- A confirmed decision crossfades to a receipt; the receipt's symbol bounces once. Reduce Motion removes the crossfade and bounce. Text always conveys the outcome independently of color and haptics.
- Don't animate background refresh, conceal a safety warning, or keep a secret visible for an exit animation. No shimmer, confetti, looping decoration or extra refresh indicators.
- Use semantic text styles/colors, native touch targets, explicit labels and vertically expanding content. The decision area remains scroll-safe at large Dynamic Type sizes.

## Verification

DEBUG-only synthetic fixtures never contact a real vault. Check pending/idle/loading/error states, review, search/no-results, secret, settings, pairing, and completion. Inspect light/dark and accessibility text sizes; inspect Reduce Motion. Run existing cryptography, OAuth/transfer and activity tests, plus design UI tests for stable refresh geometry, control placement and navigation. Receipt fixtures exercise presentation, not a real encrypted grant or device haptic.

The native owner already verified physical-device enrollment and APNs delivery before this design pass. Simulator work cannot revalidate real push delivery, Face ID or haptic feel. The next on-device check should cover one actual request, app switching during pairing, and returning from background with a revealed secret.

## Parity

This pass changes native presentation and feedback, not backend capabilities, grant envelopes or lifecycle rules. PWA and CLI protocols remain compatible. Sharing a notification pairing code uses the system share sheet and shares only the public code. Infrastructure provisioning and durable passkey recovery remain the documented CLI/PWA exceptions.
