/**
 * Cloudflare OAuth scope IDs required to provision and update a Sickrat vault.
 *
 * `workers-r2-storage.write` is the OAuth scope ID for Cloudflare's
 * "Workers R2 Storage Write" permission. Keep it: browser-session artifacts
 * require bucket creation and read/write access during vault provisioning.
 */
export const cloudflareProvisioningScopes = [
	"account-settings.read",
	"user-details.read",
	"d1.write",
	"workers-r2-storage.write",
	"workers-scripts.read",
	"workers-scripts.write",
] as const;
