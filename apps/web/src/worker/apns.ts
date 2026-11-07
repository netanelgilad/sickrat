// APNs credentials are Worker secrets; neither tokens nor keys belong in logs.
export type APNsConfig = { teamId: string; keyId: string; privateKey: string; topic: string; environment: "sandbox" | "production" };
let cached: { identity: string; token: string; expires: number } | undefined;

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function validAPNsToken(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64,200}$/.test(value);
}

export async function sendAPNs(config: APNsConfig, deviceToken: string, requestId: string | null, badgeCount: number, fetcher: typeof fetch = fetch, pairingCode?: string): Promise<{ status: number; stale: boolean }> {
	if (!Number.isSafeInteger(badgeCount) || badgeCount < 0) throw new Error("Invalid badge count");
	if (!validAPNsToken(deviceToken)) throw new Error("Invalid APNs device token");
	const identity = `${config.teamId}:${config.keyId}:${config.environment}`;
	let jwt = cached?.identity === identity && cached.expires > Date.now() ? cached.token : undefined;
	if (!jwt) {
	const keyData = config.privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
	const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(keyData), c => c.charCodeAt(0)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const encoder = new TextEncoder();
	const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: config.keyId })));
	const payload = base64url(encoder.encode(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) })));
	const unsigned = `${header}.${payload}`;
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));
	jwt = `${unsigned}.${base64url(new Uint8Array(signature))}`;
	cached = { identity, token: jwt, expires: Date.now() + 40 * 60 * 1000 };
	}
	const host = config.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
	const response = await fetcher(`https://${host}/3/device/${deviceToken}`, {
		signal: AbortSignal.timeout(5000),
		method: "POST", headers: { authorization: `bearer ${jwt}`, "apns-topic": config.topic, "apns-collapse-id": pairingCode ? "sickrat-pairing" : "sickrat-requests", "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 60), "content-type": "application/json" },
		body: JSON.stringify({ aps: { badge: badgeCount, ...((requestId || pairingCode) ? { alert: { title: "Sickrat", body: pairingCode ? "A device wants to pair with your vault." : "An access request needs your review." }, sound: "default" } : {}) }, ...(requestId ? { requestId } : {}), ...(pairingCode ? { pairingCode } : {}) }),
	});
	let reason: unknown;
	if (!response.ok) { try { reason = ((await response.json()) as {reason?: string}).reason; } catch { /* No usable error body. */ } }
	return { status: response.status, stale: response.status === 410 && reason === "Unregistered" };
}
