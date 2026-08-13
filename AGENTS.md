# Product Interface Parity

When a user-facing capability is added or changed in the Sickrat PWA or CLI, provide equivalent management and inspection support in the other interface where it is technically and security-wise appropriate. Keep the displayed metadata, validation rules, and lifecycle operations aligned. Document an intentional exception when platform constraints or the vault security model prevent direct parity; for example, OAuth reauthorization remains a PWA flow because only the PWA unlocks the encrypted refresh token with the vault key.
