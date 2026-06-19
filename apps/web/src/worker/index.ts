type PushSubscriptionRecord = {
	id: string;
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
	created_at: string;
};

type ApprovalRequestRecord = {
	id: string;
	subscription_id: string;
	device: string;
	command: string;
	message: string | null;
	secret_refs: string;
	status: "pending" | "approved" | "denied";
	created_at: string;
	decided_at: string | null;
	device_id: string | null;
	ephemeral_public_key: string | null;
	grant_ciphertext: string | null;
	grant_ready_at: string | null;
};

type SecretRecord = {
	id: string;
	ref: string;
	label: string;
	ciphertext: string;
	iv: string;
	salt: string;
	kdf: string;
	created_at: string;
	updated_at: string;
};

type SecretCiphertextInput = {
	ref?: string;
	label?: string;
	ciphertext?: string;
	iv?: string;
	salt?: string;
	kdf?: string;
};

type DeviceRecord = {
	id: string;
	label: string;
	public_key: string;
	created_at: string;
	revoked_at: string | null;
};

type PairingCodeRecord = {
	code: string;
	device_id: string;
	label: string;
	public_key: string;
	expires_at: string;
	approved_at: string | null;
};

type EnvWithBindings = Env & {
	ASSETS: Fetcher;
	APPROVAL_HUB?: DurableObjectNamespace;
	DB?: D1Database;
	CF_OAUTH_CLIENT_ID?: string;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	SICKRAT_VAULT_NAME?: string;
	SICKRAT_DEPLOYED_BY?: string;
	SICKRAT_VERSION?: string;
};

type CloudflareAccount = {
	id: string;
	name: string;
};

type CloudflareD1Database = {
	uuid: string;
	name: string;
	created_at?: string;
};

type CloudflareSecretsStore = {
	id: string;
	name: string;
	created?: string;
	modified?: string;
};

type ProvisioningStep = {
	id: "d1" | "secrets-store";
	label: string;
	status: "pending" | "success" | "error";
	detail?: string;
	error?: string;
	resource?: unknown;
};

type CloudflareTokenResponse = {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
};

const jsonHeaders = {
	"content-type": "application/json; charset=utf-8",
};

const vapidJwtCache = new Map<string, { token: string; expiresAt: number }>();

export class ApprovalHub {
	private sessions = new Set<WebSocket>();

	async fetch(request: Request) {
		if (request.headers.get("upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			server.accept();
			this.sessions.add(server);
			server.addEventListener("close", () => this.sessions.delete(server));
			server.addEventListener("error", () => this.sessions.delete(server));
			server.addEventListener("message", (event) => {
				if (event.data === "ping") server.send("pong");
			});
			return new Response(null, { status: 101, webSocket: client });
		}

		if (request.method === "POST") {
			const message = await request.text();
			for (const session of this.sessions) {
				try {
					session.send(message);
				} catch {
					this.sessions.delete(session);
				}
			}
			return json({ ok: true, delivered: this.sessions.size });
		}

		return json({ error: "Not found" }, { status: 404 });
	}
}

function json(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data, null, 2), {
		...init,
		headers: {
			...jsonHeaders,
			...(init?.headers ?? {}),
		},
	});
}

async function readCloudflareApi<T>(path: string, accessToken: string, init: RequestInit = {}) {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${accessToken}`,
			...(init.headers ?? {}),
		},
	});
	const body = (await response.json()) as {
		success: boolean;
		errors?: Array<{ code: number; message: string }>;
		messages?: unknown[];
		result: T;
	};
	if (!response.ok || !body.success) {
		const message = body.errors?.map((error) => error.message).join("; ") || `Cloudflare API returned ${response.status}`;
		throw new Error(message);
	}
	return body.result;
}

function getBearerToken(request: Request) {
	const header = request.headers.get("authorization");
	const match = header?.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

async function exchangeCloudflareCode(env: EnvWithBindings, body: { code?: string; codeVerifier?: string; redirectUri?: string }) {
	if (!env.CF_OAUTH_CLIENT_ID) throw new Error("CF_OAUTH_CLIENT_ID is not configured.");
	if (!body.code || !body.codeVerifier || !body.redirectUri) {
		throw new Error("Cloudflare authorization code, PKCE verifier, and redirect URI are required.");
	}

	const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: body.code,
			client_id: env.CF_OAUTH_CLIENT_ID,
			redirect_uri: body.redirectUri,
			code_verifier: body.codeVerifier,
		}),
	});
	const token = (await response.json()) as CloudflareTokenResponse;
	if (!response.ok || !token.access_token) {
		throw new Error(token.error_description ?? token.error ?? `Cloudflare token exchange returned ${response.status}`);
	}
	return token;
}

async function ensureD1Database(accountId: string, accessToken: string) {
	const databases = await readCloudflareApi<CloudflareD1Database[]>(
		`/accounts/${accountId}/d1/database?name=sickrat-vault&per_page=50`,
		accessToken,
	);
	const existing = databases.find((database) => database.name === "sickrat-vault");
	if (existing) return { database: existing, created: false };

	const database = await readCloudflareApi<CloudflareD1Database>(`/accounts/${accountId}/d1/database`, accessToken, {
		method: "POST",
		body: JSON.stringify({ name: "sickrat-vault" }),
	});
	return { database, created: true };
}

async function ensureSecretsStore(accountId: string, accessToken: string) {
	const stores = await readCloudflareApi<CloudflareSecretsStore[]>(
		`/accounts/${accountId}/secrets_store/stores?per_page=50`,
		accessToken,
	);
	const existing = stores.find((store) => store.name === "sickrat");
	if (existing) return { store: existing, created: false };

	const store = await readCloudflareApi<CloudflareSecretsStore>(`/accounts/${accountId}/secrets_store/stores`, accessToken, {
		method: "POST",
		body: JSON.stringify({ name: "sickrat" }),
	});
	return { store, created: true };
}

function getApprovalHub(env: EnvWithBindings, subscriptionId: string) {
	if (!env.APPROVAL_HUB) throw new Error("APPROVAL_HUB Durable Object binding is not configured.");
	const id = env.APPROVAL_HUB.idFromName(subscriptionId);
	return env.APPROVAL_HUB.get(id);
}

async function publishNotification(subscriptionId: string, payload: unknown, env: EnvWithBindings) {
	if (!env.APPROVAL_HUB) return null;
	const hub = getApprovalHub(env, subscriptionId);
	const response = await hub.fetch("https://approval-hub/publish", {
		method: "POST",
		body: JSON.stringify(payload),
	});
	return response.ok ? ((await response.json()) as { ok: true; delivered: number }) : null;
}

async function publishApproval(subscriptionId: string, approval: ReturnType<typeof mapApproval>, env: EnvWithBindings) {
	return publishNotification(
		subscriptionId,
		{
			type: "approval.requested",
			approval,
			url: `/approve/${encodeURIComponent(approval.id)}`,
		},
		env,
	);
}

async function publishPairing(subscriptionId: string, pairing: ReturnType<typeof mapPairing>, env: EnvWithBindings) {
	return publishNotification(
		subscriptionId,
		{
			type: "pairing.requested",
			pairing,
			url: "/devices",
		},
		env,
	);
}

async function getLatestNotification(subscriptionId: string, env: EnvWithBindings) {
	if (!env.DB) return null;
	const approval = await env.DB.prepare(
		`${approvalSelect}
		 WHERE subscription_id = ? AND status = 'pending'
		 ORDER BY created_at DESC
		 LIMIT 1`,
	)
		.bind(subscriptionId)
		.first<ApprovalRequestRecord>();
	if (approval) {
		const mapped = mapApproval(approval);
		return {
			type: "approval.requested",
			approval: mapped,
			url: `/approve/${encodeURIComponent(mapped.id)}`,
		};
	}

	const pairing = await env.DB.prepare(
		`SELECT code, device_id, label, public_key, expires_at, approved_at
		 FROM pairing_codes
		 WHERE approved_at IS NULL AND expires_at > ?
		 ORDER BY expires_at DESC
		 LIMIT 1`,
	)
		.bind(new Date().toISOString())
		.first<PairingCodeRecord>();
	if (!pairing) return null;
	const mapped = mapPairing(pairing);
	return {
		type: "pairing.requested",
		pairing: mapped,
		url: "/devices",
	};
}

async function ensureSchema(env: EnvWithBindings) {
	if (!env.DB) return false;
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL)",
	).run();
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS approval_requests (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, device TEXT NOT NULL, command TEXT NOT NULL, secret_refs TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT)",
	).run();
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, label TEXT NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, salt TEXT NOT NULL, kdf TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
	).run();
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, public_key TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)",
	).run();
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS pairing_codes (code TEXT PRIMARY KEY, device_id TEXT NOT NULL, label TEXT NOT NULL, public_key TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT)",
	).run();
	await ensureColumn(env.DB, "approval_requests", "device_id", "TEXT");
	await ensureColumn(env.DB, "approval_requests", "message", "TEXT");
	await ensureColumn(env.DB, "approval_requests", "ephemeral_public_key", "TEXT");
	await ensureColumn(env.DB, "approval_requests", "grant_ciphertext", "TEXT");
	await ensureColumn(env.DB, "approval_requests", "grant_ready_at", "TEXT");
	return true;
}

async function ensureColumn(db: D1Database, table: string, column: string, type: string) {
	try {
		await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.toLowerCase().includes("duplicate column")) throw error;
	}
}

function base64UrlToBytes(value: string) {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function trimLeadingZeroes(bytes: Uint8Array) {
	let index = 0;
	while (index < bytes.length - 1 && bytes[index] === 0) index += 1;
	return bytes.slice(index);
}

function leftPad(bytes: Uint8Array, length: number) {
	if (bytes.length === length) return bytes;
	if (bytes.length > length) return bytes.slice(bytes.length - length);
	const output = new Uint8Array(length);
	output.set(bytes, length - bytes.length);
	return output;
}

function normalizeEcdsaSignature(signature: ArrayBuffer) {
	const bytes = new Uint8Array(signature);
	if (bytes.length === 64) return bytes;

	if (bytes[0] !== 0x30) {
		throw new Error(`Unexpected ECDSA signature format length=${bytes.length}`);
	}

	let offset = 2;
	if (bytes[1] === 0x81) offset = 3;
	if (bytes[offset] !== 0x02) throw new Error("Invalid DER signature: missing r marker");
	const rLength = bytes[offset + 1];
	const r = bytes.slice(offset + 2, offset + 2 + rLength);
	offset = offset + 2 + rLength;
	if (bytes[offset] !== 0x02) throw new Error("Invalid DER signature: missing s marker");
	const sLength = bytes[offset + 1];
	const s = bytes.slice(offset + 2, offset + 2 + sLength);

	const output = new Uint8Array(64);
	output.set(leftPad(trimLeadingZeroes(r), 32), 0);
	output.set(leftPad(trimLeadingZeroes(s), 32), 32);
	return output;
}

async function signVapidJwt(audience: string, env: EnvWithBindings) {
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
		throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required.");
	}

	const publicKey = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
	if (publicKey.length !== 65 || publicKey[0] !== 4) {
		throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 public key.");
	}

	const jwk: JsonWebKey = {
		kty: "EC",
		crv: "P-256",
		x: bytesToBase64Url(publicKey.slice(1, 33)),
		y: bytesToBase64Url(publicKey.slice(33, 65)),
		d: env.VAPID_PRIVATE_KEY,
		ext: false,
		key_ops: ["sign"],
	};

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);

	const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const payload = bytesToBase64Url(
		new TextEncoder().encode(
			JSON.stringify({
				aud: audience,
				exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2,
				sub: "mailto:netanelgilad@gmail.com",
			}),
		),
	);
	const unsigned = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(unsigned),
	);

	return `${unsigned}.${bytesToBase64Url(normalizeEcdsaSignature(signature))}`;
}

async function getVapidJwt(audience: string, env: EnvWithBindings) {
	const cacheKey = `${audience}:${env.VAPID_PUBLIC_KEY ?? ""}`;
	const cached = vapidJwtCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.token;

	const token = await signVapidJwt(audience, env);
	vapidJwtCache.set(cacheKey, { token, expiresAt: Date.now() + 60 * 60 * 1000 });
	return token;
}

async function sendEmptyWebPush(subscription: PushSubscriptionRecord, env: EnvWithBindings) {
	const endpoint = new URL(subscription.endpoint);
	const audience = `${endpoint.protocol}//${endpoint.host}`;
	const jwt = await getVapidJwt(audience, env);

	const response = await fetch(subscription.endpoint, {
		method: "POST",
		headers: {
			Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
			TTL: "60",
			Urgency: "high",
		},
	});

	if (!response.ok && response.status !== 201) {
		if ((response.status === 404 || response.status === 410) && env.DB) {
			await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(subscription.endpoint).run();
		}
		throw new Error(`Push service returned ${response.status}: ${await response.text()}`);
	}

	return response.status;
}

function mapApproval(row: ApprovalRequestRecord) {
	return {
		id: row.id,
		subscriptionId: row.subscription_id,
		deviceId: row.device_id,
		device: row.device,
		command: row.command,
		message: row.message,
		secretRefs: JSON.parse(row.secret_refs) as string[],
		status: row.status,
		createdAt: row.created_at,
		decidedAt: row.decided_at,
		ephemeralPublicKey: row.ephemeral_public_key ? (JSON.parse(row.ephemeral_public_key) as JsonWebKey) : null,
		grantReadyAt: row.grant_ready_at,
	};
}

function mapPairing(row: PairingCodeRecord) {
	return {
		code: row.code,
		deviceId: row.device_id,
		label: row.label,
		expiresAt: row.expires_at,
		approvedAt: row.approved_at,
		expired: Date.parse(row.expires_at) <= Date.now(),
	};
}

function mapSecretCiphertext(row: SecretRecord) {
	return {
		id: row.id,
		ref: row.ref,
		label: row.label,
		ciphertext: row.ciphertext,
		iv: row.iv,
		salt: row.salt,
		kdf: row.kdf,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function canonicalApprovalPayload(input: {
	deviceId: string;
	command: string;
	message?: string;
	secretRefs: string[];
	ephemeralPublicKey: JsonWebKey;
	timestamp: string;
	nonce: string;
}) {
	return JSON.stringify({
		deviceId: input.deviceId,
		command: input.command,
		message: input.message,
		secretRefs: input.secretRefs,
		ephemeralPublicKey: input.ephemeralPublicKey,
		timestamp: input.timestamp,
		nonce: input.nonce,
	});
}

async function verifyDeviceSignature(device: DeviceRecord, body: {
	deviceId?: string;
	command?: string;
	message?: string;
	secretRefs?: string[];
	ephemeralPublicKey?: JsonWebKey;
	timestamp?: string;
	nonce?: string;
	signature?: string;
}) {
	if (
		!body.deviceId ||
		!body.command ||
		!Array.isArray(body.secretRefs) ||
		!body.ephemeralPublicKey ||
		!body.timestamp ||
		!body.nonce ||
		!body.signature
	) {
		return false;
	}

	const timestamp = Date.parse(body.timestamp);
	if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return false;

	const publicKey = await crypto.subtle.importKey(
		"jwk",
		JSON.parse(device.public_key) as JsonWebKey,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		publicKey,
		base64UrlToBytes(body.signature),
		new TextEncoder().encode(
			canonicalApprovalPayload({
				deviceId: body.deviceId,
				command: body.command,
				message: body.message,
				secretRefs: body.secretRefs,
				ephemeralPublicKey: body.ephemeralPublicKey,
				timestamp: body.timestamp,
				nonce: body.nonce,
			}),
		),
	);
}

function randomPairingCode() {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
	return String((value % 900_000) + 100_000);
}

const approvalSelect = `
	SELECT id, subscription_id, device, command, secret_refs, status, created_at, decided_at,
		device_id, message, ephemeral_public_key, grant_ciphertext, grant_ready_at
	FROM approval_requests
`;

function isValidSecretRef(ref: unknown) {
	return typeof ref === "string" && ref.trim() === ref && ref.length > 0 && ref.length <= 512;
}

function isValidApprovalMessage(message: unknown) {
	return message === undefined || (typeof message === "string" && message.trim() === message && message.length <= 600);
}

function isValidSecretCiphertextInput(secret: SecretCiphertextInput) {
	return (
		isValidSecretRef(secret.ref) &&
		typeof secret.label === "string" &&
		secret.label.trim() === secret.label &&
		secret.label.length > 0 &&
		secret.label.length <= 512 &&
		typeof secret.ciphertext === "string" &&
		secret.ciphertext.length > 0 &&
		typeof secret.iv === "string" &&
		secret.iv.length > 0 &&
		typeof secret.salt === "string" &&
		secret.salt.length > 0 &&
		typeof secret.kdf === "string" &&
		secret.kdf.length > 0 &&
		secret.kdf.length <= 128
	);
}

function mapSecret(row: Pick<SecretRecord, "id" | "ref" | "label" | "kdf" | "created_at" | "updated_at">) {
	return {
		id: row.id,
		ref: row.ref,
		label: row.label,
		kdf: row.kdf,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapDevice(row: DeviceRecord) {
	return {
		id: row.id,
		label: row.label,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	};
}

async function createDemoApproval(subscriptionId: string, env: EnvWithBindings) {
	if (!env.DB) throw new Error("D1 binding is not configured.");
	const id = crypto.randomUUID();
	const createdAt = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO approval_requests
			(id, subscription_id, device, command, message, secret_refs, status, created_at, decided_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
	)
		.bind(
			id,
			subscriptionId,
			"mac-mini.local",
			"sickrat run --env-file .env -- npm test",
			"Run the test suite with the same API access the agent will use in CI.",
			JSON.stringify(["openai/api-key", "prod/database/url"]),
			createdAt,
		)
		.run();
	return id;
}

async function handleApi(request: Request, env: EnvWithBindings) {
	const url = new URL(request.url);

	if (url.pathname === "/api/cloudflare/oauth-config" && request.method === "GET") {
		return json({
			clientId: env.CF_OAUTH_CLIENT_ID ?? null,
			authUrl: "https://dash.cloudflare.com/oauth2/auth",
			tokenUrl: "https://dash.cloudflare.com/oauth2/token",
			redirectUri: `${url.origin}/cf/callback`,
			scopes: [
				"account-settings.read",
				"user-details.read",
				"d1.write",
				"secrets-store.write",
				"workers-scripts.read",
				"workers-scripts.write",
			],
		});
	}

	if (url.pathname === "/api/cloudflare/oauth-token" && request.method === "POST") {
		try {
			const body = (await request.json()) as { code?: string; codeVerifier?: string; redirectUri?: string };
			const token = await exchangeCloudflareCode(env, body);
			return json({
				accessToken: token.access_token,
				expiresIn: token.expires_in ?? null,
				scope: token.scope ?? null,
				tokenType: token.token_type ?? "bearer",
			});
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "Cloudflare token exchange failed." }, { status: 400 });
		}
	}

	if (url.pathname === "/api/cloudflare/accounts" && request.method === "GET") {
		const accessToken = getBearerToken(request);
		if (!accessToken) return json({ error: "Missing Cloudflare OAuth bearer token." }, { status: 401 });
		try {
			const accounts = await readCloudflareApi<CloudflareAccount[]>("/accounts?per_page=50", accessToken);
			return json({ accounts });
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "Failed to list Cloudflare accounts." }, { status: 502 });
		}
	}

	if (url.pathname === "/api/cloudflare/provision" && request.method === "POST") {
		const accessToken = getBearerToken(request);
		if (!accessToken) return json({ error: "Missing Cloudflare OAuth bearer token." }, { status: 401 });
		const body = (await request.json()) as { accountId?: string };
		if (!body.accountId) return json({ error: "Cloudflare account id is required." }, { status: 400 });

		const steps: ProvisioningStep[] = [];
		const resources: Record<string, unknown> = {};

		try {
			const d1 = await ensureD1Database(body.accountId, accessToken);
			resources.d1 = d1;
			steps.push({
				id: "d1",
				label: "D1 database",
				status: "success",
				detail: `${d1.database.name} (${d1.created ? "created" : "already existed"})`,
				resource: d1,
			});
		} catch (error) {
			steps.push({
				id: "d1",
				label: "D1 database",
				status: "error",
				error: error instanceof Error ? error.message : "Failed to create or find D1 database.",
			});
		}

		try {
			const secretsStore = await ensureSecretsStore(body.accountId, accessToken);
			resources.secretsStore = secretsStore;
			steps.push({
				id: "secrets-store",
				label: "Secrets Store",
				status: "success",
				detail: `${secretsStore.store.name} (${secretsStore.created ? "created" : "already existed"})`,
				resource: secretsStore,
			});
		} catch (error) {
			steps.push({
				id: "secrets-store",
				label: "Secrets Store",
				status: "error",
				error: error instanceof Error ? error.message : "Failed to create or find Secrets Store.",
			});
		}

		return json({
			ok: steps.every((step) => step.status === "success"),
			accountId: body.accountId,
			steps,
			resources,
			next: "Worker binding/deployment handoff is next: this created account-owned resources, but the running Worker must be deployed or reconfigured to bind to them.",
		});
	}

	if (url.pathname === "/api/realtime" && request.headers.get("upgrade") === "websocket") {
		const subscriptionId = url.searchParams.get("subscriptionId");
		if (!subscriptionId) return json({ error: "subscriptionId is required." }, { status: 400 });
		try {
			return getApprovalHub(env, subscriptionId).fetch(request);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "Realtime channel is unavailable." }, { status: 500 });
		}
	}

	if (url.pathname === "/api/capabilities" && request.method === "GET") {
		return json({
			ok: true,
			push: {
				supported: true,
				configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
				vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
			},
			database: {
				configured: Boolean(env.DB),
			},
			vault: {
				name: env.SICKRAT_VAULT_NAME ?? "default",
				deployedBy: env.SICKRAT_DEPLOYED_BY ?? "unknown",
				version: env.SICKRAT_VERSION ?? "unknown",
			},
			ios: {
				requiresHomeScreenInstall: true,
			},
		});
	}

	if (url.pathname === "/api/devices" && request.method === "GET") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const result = await env.DB.prepare(
			"SELECT id, label, public_key, created_at, revoked_at FROM devices ORDER BY created_at DESC LIMIT 100",
		).all<DeviceRecord>();
		return json({ devices: result.results.map(mapDevice) });
	}

	const revokeDeviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
	if (revokeDeviceMatch && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const id = decodeURIComponent(revokeDeviceMatch[1]);
		const revokedAt = new Date().toISOString();
		await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(revokedAt, id).run();
		const device = await env.DB.prepare("SELECT id, label, public_key, created_at, revoked_at FROM devices WHERE id = ?")
			.bind(id)
			.first<DeviceRecord>();
		if (!device) return json({ error: "Device not found." }, { status: 404 });
		return json({ ok: true, device: mapDevice(device) });
	}

	if (url.pathname === "/api/devices/pairing-codes" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as { label?: string; publicKey?: JsonWebKey };
		if (!body.label || !body.publicKey) return json({ error: "Device label and public key are required." }, { status: 400 });

		const deviceId = crypto.randomUUID();
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
		let code = randomPairingCode();
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await env.DB.prepare(
					`INSERT INTO pairing_codes (code, device_id, label, public_key, expires_at, approved_at)
					 VALUES (?, ?, ?, ?, ?, NULL)`,
				)
					.bind(code, deviceId, body.label, JSON.stringify(body.publicKey), expiresAt)
					.run();
				let pushStatus: number | null = null;
				const subscription = await env.DB.prepare("SELECT id, endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY created_at DESC LIMIT 1")
					.first<PushSubscriptionRecord & { p256dh: string; auth: string }>();
				let realtime: { ok: true; delivered: number } | null = null;
				if (subscription) {
					const pairing = await env.DB.prepare(
						"SELECT code, device_id, label, public_key, expires_at, approved_at FROM pairing_codes WHERE code = ?",
					)
						.bind(code)
						.first<PairingCodeRecord>();
					if (pairing) realtime = await publishPairing(subscription.id, mapPairing(pairing), env);
					try {
						pushStatus = await sendEmptyWebPush(
							{
								id: subscription.id,
								endpoint: subscription.endpoint,
								keys: { p256dh: subscription.p256dh, auth: subscription.auth },
								created_at: subscription.created_at,
							},
							env,
						);
					} catch {
						// The CLI still shows the pairing code and polls for approval.
					}
				}
				return json({ code, deviceId, expiresAt, realtime, pushStatus });
			} catch (error) {
				if (attempt === 4) throw error;
				code = randomPairingCode();
			}
		}
		return json({ error: "Failed to create a unique pairing code." }, { status: 500 });
	}

	const pairingCodeMatch = url.pathname.match(/^\/api\/devices\/pairing-codes\/([0-9]{6})(?:\/(approve|status))?$/);
	if (pairingCodeMatch && request.method === "GET" && pairingCodeMatch[2] !== "approve") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const code = pairingCodeMatch[1];
		const row = await env.DB.prepare(
			"SELECT code, device_id, label, public_key, expires_at, approved_at FROM pairing_codes WHERE code = ?",
		)
			.bind(code)
			.first<PairingCodeRecord>();
		if (!row) return json({ error: "Pairing code not found." }, { status: 404 });
		const expired = Date.parse(row.expires_at) <= Date.now();
		if (pairingCodeMatch[2] === "status") {
			return json({
				status: row.approved_at ? "approved" : expired ? "expired" : "pending",
				deviceId: row.device_id,
				workerUrl: url.origin,
			});
		}
		return json({
			code: row.code,
			deviceId: row.device_id,
			label: row.label,
			expiresAt: row.expires_at,
			approvedAt: row.approved_at,
			expired,
		});
	}

	if (pairingCodeMatch && pairingCodeMatch[2] === "approve" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const code = pairingCodeMatch[1];
		const row = await env.DB.prepare(
			"SELECT code, device_id, label, public_key, expires_at, approved_at FROM pairing_codes WHERE code = ?",
		)
			.bind(code)
			.first<PairingCodeRecord>();
		if (!row) return json({ error: "Pairing code not found." }, { status: 404 });
		if (row.approved_at) return json({ ok: true, deviceId: row.device_id, status: "approved" });
		if (Date.parse(row.expires_at) <= Date.now()) return json({ error: "Pairing code expired." }, { status: 410 });

		const now = new Date().toISOString();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO devices (id, label, public_key, created_at, revoked_at)
				 VALUES (?, ?, ?, ?, NULL)
				 ON CONFLICT(id) DO UPDATE SET
					label = excluded.label,
					public_key = excluded.public_key,
					revoked_at = NULL`,
			).bind(row.device_id, row.label, row.public_key, now),
			env.DB.prepare("UPDATE pairing_codes SET approved_at = ? WHERE code = ?").bind(now, code),
		]);
		return json({ ok: true, deviceId: row.device_id, status: "approved" });
	}

	if (url.pathname === "/api/approval-requests" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as {
			deviceId?: string;
			command?: string;
			message?: string;
			secretRefs?: string[];
			ephemeralPublicKey?: JsonWebKey;
			timestamp?: string;
			nonce?: string;
			signature?: string;
		};
		if (!body.deviceId) return json({ error: "deviceId is required." }, { status: 400 });
		const device = await env.DB.prepare("SELECT id, label, public_key, created_at, revoked_at FROM devices WHERE id = ?")
			.bind(body.deviceId)
			.first<DeviceRecord>();
		if (!device || device.revoked_at) return json({ error: "Device is not paired." }, { status: 403 });
		if (!(await verifyDeviceSignature(device, body))) return json({ error: "Invalid device signature." }, { status: 403 });
		if (!body.secretRefs?.length || body.secretRefs.some((ref) => !isValidSecretRef(ref))) {
			return json({ error: "At least one non-empty secret ref is required." }, { status: 400 });
		}
		if (!isValidApprovalMessage(body.message)) {
			return json({ error: "Message must be 600 characters or fewer without leading or trailing spaces." }, { status: 400 });
		}

		const subscription = await env.DB.prepare("SELECT id, endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY created_at DESC LIMIT 1")
			.first<PushSubscriptionRecord & { p256dh: string; auth: string }>();
		if (!subscription) return json({ error: "No push subscription is registered. Open the PWA and enable push first." }, { status: 409 });

		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO approval_requests
				(id, subscription_id, device, command, message, secret_refs, status, created_at, decided_at, device_id, ephemeral_public_key, grant_ciphertext, grant_ready_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL, NULL)`,
		)
			.bind(
				id,
				subscription.id,
				device.label,
				body.command,
				body.message ?? null,
				JSON.stringify(body.secretRefs),
				createdAt,
				device.id,
				JSON.stringify(body.ephemeralPublicKey),
			)
			.run();
		const approval = await env.DB.prepare(`${approvalSelect} WHERE id = ?`).bind(id).first<ApprovalRequestRecord>();
		const realtime = approval ? await publishApproval(subscription.id, mapApproval(approval), env) : null;
		let pushStatus: number | null = null;
		try {
			pushStatus = await sendEmptyWebPush(
				{
					id: subscription.id,
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.p256dh, auth: subscription.auth },
					created_at: subscription.created_at,
				},
				env,
			);
		} catch {
			// Realtime delivery may still have succeeded; the CLI will keep polling either way.
		}
		return json({ requestId: id, status: "pending", realtime, pushStatus });
	}

	if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as {
			subscription?: {
				endpoint?: string;
				keys?: {
					p256dh?: string;
					auth?: string;
				};
			};
		};
		const subscription = body.subscription;
		if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
			return json({ error: "Invalid PushSubscription JSON." }, { status: 400 });
		}
		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(endpoint) DO UPDATE SET
				id = excluded.id,
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				created_at = excluded.created_at`,
		)
			.bind(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, createdAt)
			.run();
		return json({ id, endpoint: subscription.endpoint, createdAt });
	}

	if (url.pathname === "/api/push/test" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as { id?: string };
		if (!body.id) return json({ error: "Subscription id is required." }, { status: 400 });
		const result = await env.DB.prepare(
			"SELECT id, endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE id = ?",
		)
			.bind(body.id)
			.first<PushSubscriptionRecord & { p256dh: string; auth: string }>();
		if (!result) return json({ error: "Subscription not found." }, { status: 404 });
		const requestId = await createDemoApproval(result.id, env);
		const approvalRow = await env.DB.prepare(`${approvalSelect} WHERE id = ?`)
			.bind(requestId)
			.first<ApprovalRequestRecord>();
		const realtime = approvalRow ? await publishApproval(result.id, mapApproval(approvalRow), env) : null;
		const status = await sendEmptyWebPush(
			{
				id: result.id,
				endpoint: result.endpoint,
				keys: {
					p256dh: result.p256dh,
					auth: result.auth,
				},
				created_at: result.created_at,
			},
			env,
		);
		return json({ ok: true, status, requestId, realtime });
	}

	if (url.pathname === "/api/secrets" && request.method === "GET") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const result = await env.DB.prepare(
			"SELECT id, ref, label, kdf, created_at, updated_at FROM secrets ORDER BY updated_at DESC LIMIT 100",
		).all<Pick<SecretRecord, "id" | "ref" | "label" | "kdf" | "created_at" | "updated_at">>();
		return json({ secrets: result.results.map(mapSecret) });
	}

	if (url.pathname === "/api/secrets/resolve" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as { refs?: string[] };
		const refs = body.refs ?? [];
		if (refs.length === 0 || refs.some((ref) => !isValidSecretRef(ref))) {
			return json({ error: "At least one non-empty secret ref is required." }, { status: 400 });
		}
		if (refs.length > 20) return json({ error: "Resolve is limited to 20 refs per request." }, { status: 400 });

		const secrets: ReturnType<typeof mapSecretCiphertext>[] = [];
		for (const ref of refs) {
			const row = await env.DB.prepare(
				"SELECT id, ref, label, ciphertext, iv, salt, kdf, created_at, updated_at FROM secrets WHERE ref = ?",
			)
				.bind(ref)
				.first<SecretRecord>();
			if (!row) return json({ error: `Secret not found: ${ref}` }, { status: 404 });
			secrets.push(mapSecretCiphertext(row));
		}
		return json({ secrets });
	}

	if (url.pathname === "/api/secrets" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as SecretCiphertextInput;
		if (!isValidSecretCiphertextInput(body)) {
			return json({ error: "Secret ref, label, ciphertext, iv, salt, and kdf are required." }, { status: 400 });
		}

		const now = new Date().toISOString();
		const existing = await env.DB.prepare("SELECT id, created_at FROM secrets WHERE ref = ?")
			.bind(body.ref)
			.first<{ id: string; created_at: string }>();
		const id = existing?.id ?? crypto.randomUUID();
		const createdAt = existing?.created_at ?? now;

		await env.DB.prepare(
			`INSERT INTO secrets (id, ref, label, ciphertext, iv, salt, kdf, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(ref) DO UPDATE SET
				label = excluded.label,
				ciphertext = excluded.ciphertext,
				iv = excluded.iv,
				salt = excluded.salt,
				kdf = excluded.kdf,
				updated_at = excluded.updated_at`,
		)
			.bind(id, body.ref, body.label, body.ciphertext, body.iv, body.salt, body.kdf, createdAt, now)
			.run();

		return json({ secret: { id, ref: body.ref, label: body.label, kdf: body.kdf, createdAt, updatedAt: now } });
	}

	if (url.pathname === "/api/approvals/latest" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as { endpoint?: string };
		if (!body.endpoint) return json({ error: "Subscription endpoint is required." }, { status: 400 });
		const subscription = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
			.bind(body.endpoint)
			.first<{ id: string }>();
		if (!subscription) return json({ error: "Subscription not found." }, { status: 404 });
		const approval = await env.DB.prepare(
			`${approvalSelect}
			 WHERE subscription_id = ? AND status = 'pending'
			 ORDER BY created_at DESC
			 LIMIT 1`,
		)
			.bind(subscription.id)
			.first<ApprovalRequestRecord>();
		return json({ approval: approval ? mapApproval(approval) : null });
	}

	if (url.pathname === "/api/pairing/latest" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as { endpoint?: string };
		if (!body.endpoint) return json({ error: "Subscription endpoint is required." }, { status: 400 });
		const subscription = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
			.bind(body.endpoint)
			.first<{ id: string }>();
		if (!subscription) return json({ error: "Subscription not found." }, { status: 404 });
		const pairing = await env.DB.prepare(
			`SELECT code, device_id, label, public_key, expires_at, approved_at
			 FROM pairing_codes
			 WHERE approved_at IS NULL AND expires_at > ?
			 ORDER BY expires_at DESC
			 LIMIT 1`,
		)
			.bind(new Date().toISOString())
			.first<PairingCodeRecord>();
		return json({ pairing: pairing ? mapPairing(pairing) : null });
	}

	if (url.pathname === "/api/notifications/latest" && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const body = (await request.json()) as { endpoint?: string };
		if (!body.endpoint) return json({ error: "Subscription endpoint is required." }, { status: 400 });
		const subscription = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
			.bind(body.endpoint)
			.first<{ id: string }>();
		if (!subscription) return json({ error: "Subscription not found." }, { status: 404 });
		return json({ notification: await getLatestNotification(subscription.id, env) });
	}

	if (url.pathname === "/api/approvals" && request.method === "GET") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const status = url.searchParams.get("status");
		if (status && status !== "pending" && status !== "approved" && status !== "denied") {
			return json({ error: "Status must be pending, approved, or denied." }, { status: 400 });
		}
		const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
		const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 100;
		const statement = status
			? env.DB.prepare(`${approvalSelect} WHERE status = ? ORDER BY created_at DESC LIMIT ?`).bind(status, limit)
			: env.DB.prepare(`${approvalSelect} ORDER BY created_at DESC LIMIT ?`).bind(limit);
		const result = await statement.all<ApprovalRequestRecord>();
		return json({ approvals: result.results.map(mapApproval) });
	}

	if (url.pathname.startsWith("/api/approvals/") && !url.pathname.endsWith("/grant") && request.method === "GET") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const id = url.pathname.split("/").at(-1);
		const approval = await env.DB.prepare(`${approvalSelect} WHERE id = ?`)
			.bind(id)
			.first<ApprovalRequestRecord>();
		if (!approval) return json({ error: "Approval request not found." }, { status: 404 });
		return json({ approval: mapApproval(approval) });
	}

	const approvalGrantMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/grant$/);
	if (approvalGrantMatch && request.method === "GET") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const id = decodeURIComponent(approvalGrantMatch[1]);
		const row = await env.DB.prepare(
			"SELECT id, status, grant_ciphertext, grant_ready_at FROM approval_requests WHERE id = ?",
		)
			.bind(id)
			.first<{ id: string; status: "pending" | "approved" | "denied"; grant_ciphertext: string | null; grant_ready_at: string | null }>();
		if (!row) return json({ error: "Approval request not found." }, { status: 404 });
		return json({
			requestId: row.id,
			status: row.status,
			grantCiphertext: row.grant_ciphertext ? (JSON.parse(row.grant_ciphertext) as unknown) : null,
			grantReadyAt: row.grant_ready_at,
		});
	}

	if (approvalGrantMatch && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const id = decodeURIComponent(approvalGrantMatch[1]);
		const body = (await request.json()) as { grantCiphertext?: unknown; createdSecrets?: SecretCiphertextInput[] };
		if (!body.grantCiphertext) return json({ error: "grantCiphertext is required." }, { status: 400 });
		const approval = await env.DB.prepare(`${approvalSelect} WHERE id = ?`)
			.bind(id)
			.first<ApprovalRequestRecord>();
		if (!approval) return json({ error: "Approval request not found." }, { status: 404 });
		if (approval.status !== "pending") return json({ error: `Approval request is already ${approval.status}.` }, { status: 409 });

		const requestedRefs = JSON.parse(approval.secret_refs) as string[];
		const requestedRefSet = new Set(requestedRefs);
		const createdSecrets = body.createdSecrets ?? [];
		if (!Array.isArray(createdSecrets)) return json({ error: "createdSecrets must be an array." }, { status: 400 });
		if (createdSecrets.length > requestedRefs.length) {
			return json({ error: "createdSecrets cannot exceed the number of requested refs." }, { status: 400 });
		}

		const createdRefSet = new Set<string>();
		for (const secret of createdSecrets) {
			if (!isValidSecretCiphertextInput(secret)) {
				return json({ error: "Every created secret requires ref, label, ciphertext, iv, salt, and kdf." }, { status: 400 });
			}
			const ref = secret.ref as string;
			if (!requestedRefSet.has(ref)) return json({ error: `Created secret was not requested: ${ref}` }, { status: 400 });
			if (createdRefSet.has(ref)) return json({ error: `Duplicate created secret ref: ${ref}` }, { status: 400 });
			createdRefSet.add(ref);
			const existing = await env.DB.prepare("SELECT id FROM secrets WHERE ref = ?").bind(ref).first<{ id: string }>();
			if (existing) return json({ error: `Secret already exists and will not be overwritten: ${ref}` }, { status: 409 });
		}

		const decidedAt = new Date().toISOString();
		const statements = createdSecrets.map((secret) =>
			env.DB!.prepare(
				`INSERT INTO secrets (id, ref, label, ciphertext, iv, salt, kdf, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				crypto.randomUUID(),
				secret.ref,
				secret.label,
				secret.ciphertext,
				secret.iv,
				secret.salt,
				secret.kdf,
				decidedAt,
				decidedAt,
			),
		);
		statements.push(
			env.DB.prepare(
				"UPDATE approval_requests SET status = 'approved', decided_at = ?, grant_ciphertext = ?, grant_ready_at = ? WHERE id = ? AND status = 'pending'",
			).bind(decidedAt, JSON.stringify(body.grantCiphertext), decidedAt, id),
		);
		await env.DB.batch(statements);
		return json({ ok: true, id, status: "approved", decidedAt });
	}

	if (url.pathname.startsWith("/api/approvals/") && request.method === "POST") {
		if (!(await ensureSchema(env)) || !env.DB) return json({ error: "D1 binding is not configured." }, { status: 500 });
		const parts = url.pathname.split("/");
		const action = parts.at(-1);
		const id = parts.at(-2);
		if (action !== "approve" && action !== "deny") {
			return json({ error: "Unknown approval action." }, { status: 400 });
		}
		const status = action === "approve" ? "approved" : "denied";
		const decidedAt = new Date().toISOString();
		await env.DB.prepare("UPDATE approval_requests SET status = ?, decided_at = ? WHERE id = ?")
			.bind(status, decidedAt, id)
			.run();
		return json({ ok: true, id, status, decidedAt });
	}

	return json({ error: "Not found" }, { status: 404 });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) return handleApi(request, env as EnvWithBindings);
		return (env as EnvWithBindings).ASSETS.fetch(request);
	},
} satisfies ExportedHandler<EnvWithBindings>;
