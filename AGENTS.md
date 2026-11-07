# Product Interface Parity

The native iOS app is the only owner-facing app. When a user-facing capability is added or changed in iOS or the CLI, provide equivalent management and inspection support in the other interface where technically and security-wise appropriate. Align metadata, validation rules, and lifecycle operations. Document intentional exceptions: only authenticated owner clients hold the vault root key, so OAuth connection/reauthorization, root-key recovery, and root-key transfer remain native iOS flows. The CLI must never receive the root key or provider refresh tokens. The Cloudflare Worker is the backend, and its browser pages only hand off to iOS or complete system OAuth; do not restore a PWA console.

# Release Discipline

Create release tags only after their target commit is on `main`. Releases must be built from a commit reachable from `origin/main`; do not tag a feature branch or an unmerged local commit. The release workflow enforces this requirement, so preserve that guard when changing release automation.
