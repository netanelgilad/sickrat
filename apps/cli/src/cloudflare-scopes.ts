/**
 * Cloudflare OAuth scope IDs required to provision and update a Sickrat vault.
 *
 * `workers-r2.write` is the OAuth scope ID configured for Sickrat's
 * Cloudflare OAuth client. Keep it: browser-session artifacts
 * require bucket creation and read/write access during vault provisioning.
 */
export const cloudflareProvisioningScopes = [
	"offline_access",
	"account-settings.read",
	"user-details.read",
	"d1.write",
	"workers-r2.write",
	"workers-scripts.read",
	"workers-scripts.write",
] as const;
