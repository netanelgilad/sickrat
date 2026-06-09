#!/usr/bin/env bun
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { canonicalApprovalPayload, type ApprovalRequestCreate, type EncryptedGrant, type GrantPayload, type PairingCodeResponse, type PairingCodeStatusResponse } from "@sickrat/protocol";

type Config = {
	workerUrl?: string;
	deviceId?: string;
	label?: string;
	signingPrivateKey?: JsonWebKey;
	signingPublicKey?: JsonWebKey;
	pairedAt?: string;
	cloudflare?: {
		clientId: string;
		accessToken: string;
		refreshToken?: string;
		expiresAt?: string;
		scope?: string;
		tokenType: string;
		loggedInAt: string;
	};
	vaults?: Array<{
		name: string;
		slug: string;
		accountId: string;
		accountName: string;
		scriptName: string;
		d1Name: string;
		d1Id: string;
		workerUrl: string;
		createdAt: string;
	}>;
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

type CloudflareWorkersSubdomain = {
	subdomain?: string;
	enabled?: boolean;
	previews_enabled?: boolean;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const configPath = join(homedir(), ".sickrat", "config.json");
const sourcePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(sourcePath), "../../..");
const webWorkspace = join(repoRoot, "apps/web");
const webWorkerBuildDir = join(webWorkspace, "dist/sickrat");
const grantWrapInfo = textEncoder.encode("sickrat:cli-grant:v1");
const grantWrapSalt = textEncoder.encode("sickrat:grant-ecdh:v1");
const defaultCloudflareClientId = "768469d277d474beaedd85115b63a81d";

function usage(exitCode = 0): never {
	const output = `sickrat

Usage:
  sickrat login [--client-id <id>] [--port <port>]
  sickrat vault create [name] [--account-id <id>]
  sickrat pair <worker-url> [--label <name>]
  sickrat request <ref> [--message <why>]

Examples:
  sickrat login
  sickrat vault create personal
  sickrat pair https://sickrat-personal.<your-subdomain>.workers.dev
  sickrat request leumi --message "Reconcile today's bank transactions"
`;
	(exitCode === 0 ? console.log : console.error)(output);
	process.exit(exitCode);
}

function bytesToBase64Url(bytes: Uint8Array) {
	return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string) {
	return new Uint8Array(Buffer.from(value, "base64url"));
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
	if (bytes[0] !== 0x30) throw new Error(`Unexpected ECDSA signature length: ${bytes.length}`);

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

function getArgValue(args: string[], name: string) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : null;
}

function getAnyArgValue(args: string[], names: string[]) {
	for (const name of names) {
		const value = getArgValue(args, name);
		if (value) return value;
	}
	return null;
}

function randomBase64Url(byteLength: number) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string) {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
	return bytesToBase64Url(new Uint8Array(digest));
}

function normalizeWorkerUrl(value: string) {
	const url = new URL(value);
	url.pathname = "";
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

async function api<T>(workerUrl: string, path: string, init: RequestInit = {}) {
	const response = await fetch(`${workerUrl}${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const body = (await response.json().catch(() => null)) as T & { error?: string } | null;
	if (!response.ok) throw new Error(body?.error ?? `Request failed with HTTP ${response.status}`);
	return body as T;
}

async function readConfig() {
	try {
		return JSON.parse(await readFile(configPath, "utf8")) as Config;
	} catch {
		return {} satisfies Config;
	}
}

async function writeConfig(config: Config) {
	await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function openBrowser(url: string) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { stdio: "ignore", detached: true });
	child.unref();
}

async function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	return await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
		});
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
		result: T;
	};
	if (!response.ok || !body.success) {
		const message = body.errors?.map((error) => error.message).join("; ") || `Cloudflare API returned ${response.status}`;
		throw new Error(message);
	}
	return body.result;
}

async function ensureCloudflareConfig() {
	const config = await readConfig();
	if (!config.cloudflare?.accessToken) {
		throw new Error("Cloudflare is not logged in. Run sickrat login first.");
	}
	return { config, cloudflare: config.cloudflare };
}

async function cloudflareLogin(args: string[]) {
	const clientId = getArgValue(args, "--client-id") ?? process.env.SICKRAT_CF_CLIENT_ID ?? defaultCloudflareClientId;
	const port = Number(getArgValue(args, "--port") ?? process.env.SICKRAT_CF_CALLBACK_PORT ?? "8977");
	if (!Number.isInteger(port) || port <= 0) throw new Error("Callback port must be a positive integer.");

	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const state = randomBase64Url(24);
	const codeVerifier = randomBase64Url(72);
	const codeChallenge = await sha256Base64Url(codeVerifier);
	const scopes = [
		"account-settings.read",
		"user-details.read",
		"d1.write",
		"workers-scripts.read",
		"workers-scripts.write",
	];

	const authUrl = new URL("https://dash.cloudflare.com/oauth2/auth");
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", clientId);
	authUrl.searchParams.set("redirect_uri", redirectUri);
	authUrl.searchParams.set("scope", scopes.join(" "));
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", codeChallenge);
	authUrl.searchParams.set("code_challenge_method", "S256");

	const code = await new Promise<string>((resolve, reject) => {
		const server = createServer((request, response) => {
			const requestUrl = new URL(request.url ?? "/", redirectUri);
			if (requestUrl.pathname !== "/callback") {
				response.writeHead(404);
				response.end("Not found");
				return;
			}

			const error = requestUrl.searchParams.get("error");
			if (error) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end(`Cloudflare login failed: ${error}`);
				server.close();
				reject(new Error(requestUrl.searchParams.get("error_description") ?? error));
				return;
			}

			if (requestUrl.searchParams.get("state") !== state) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("Invalid OAuth state.");
				server.close();
				reject(new Error("Cloudflare login returned an invalid OAuth state."));
				return;
			}

			const nextCode = requestUrl.searchParams.get("code");
			if (!nextCode) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("Missing OAuth code.");
				server.close();
				reject(new Error("Cloudflare login did not return an authorization code."));
				return;
			}

			response.writeHead(200, { "content-type": "text/plain" });
			response.end("Cloudflare login complete. You can return to your terminal.");
			server.close();
			resolve(nextCode);
		});

		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			console.error(`Opening Cloudflare login in your browser...`);
			console.error(`Callback: ${redirectUri}`);
			openBrowser(authUrl.toString());
		});
	});

	const tokenResponse = await fetch("https://dash.cloudflare.com/oauth2/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: clientId,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		}),
	});
	const token = (await tokenResponse.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		token_type?: string;
		error?: string;
		error_description?: string;
	};
	if (!tokenResponse.ok || !token.access_token) {
		throw new Error(token.error_description ?? token.error ?? `Cloudflare token exchange returned ${tokenResponse.status}`);
	}

	const config = await readConfig();
	await writeConfig({
		...config,
		cloudflare: {
			clientId,
			accessToken: token.access_token,
			refreshToken: token.refresh_token,
			expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined,
			scope: token.scope,
			tokenType: token.token_type ?? "bearer",
			loggedInAt: new Date().toISOString(),
		},
	});
	console.error(`Cloudflare login saved to ${configPath}.`);
}

async function chooseCloudflareAccount(accessToken: string, preferredAccountId?: string | null) {
	const accounts = await readCloudflareApi<CloudflareAccount[]>("/accounts?per_page=50", accessToken);
	if (preferredAccountId) {
		const selected = accounts.find((account) => account.id === preferredAccountId);
		if (!selected) throw new Error(`Cloudflare account not found or not accessible: ${preferredAccountId}`);
		return selected;
	}
	if (accounts.length === 0) throw new Error("No Cloudflare accounts were returned for this login.");
	if (accounts.length === 1) return accounts[0];

	if (!process.stdin.isTTY) {
		throw new Error(
			`Multiple Cloudflare accounts are available. Re-run with --account-id. Options: ${accounts
				.map((account) => `${account.name}=${account.id}`)
				.join(", ")}`,
		);
	}

	console.error("Select a Cloudflare account:");
	accounts.forEach((account, index) => {
		console.error(`  ${index + 1}. ${account.name} (${account.id})`);
	});
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await readline.question("Account number: ");
		const index = Number(answer.trim()) - 1;
		const selected = accounts[index];
		if (!selected) throw new Error("Invalid account selection.");
		return selected;
	} finally {
		readline.close();
	}
}

function normalizeVaultName(name: string | undefined) {
	const value = name?.trim() || "default";
	const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!slug) throw new Error("Vault name must contain at least one letter or number.");
	return { name: value, slug };
}

function getVaultResourceNames(vaultName: string | undefined) {
	const vault = normalizeVaultName(vaultName);
	return {
		...vault,
		d1Name: `sickrat-${vault.slug}-vault`,
		scriptName: `sickrat-${vault.slug}`,
	};
}

async function ensureD1Database(accountId: string, accessToken: string, databaseName: string) {
	const databases = await readCloudflareApi<CloudflareD1Database[]>(
		`/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=50`,
		accessToken,
	);
	const existing = databases.find((database) => database.name === databaseName);
	if (existing) return { database: existing, created: false };

	const database = await readCloudflareApi<CloudflareD1Database>(`/accounts/${accountId}/d1/database`, accessToken, {
		method: "POST",
		body: JSON.stringify({ name: databaseName }),
	});
	return { database, created: true };
}

function base64UrlToBase64(value: string) {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	return `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
}

async function generateVapidKeys() {
	const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const privateKey = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
	if (!publicKey.x || !publicKey.y || !privateKey.d) throw new Error("Failed to generate VAPID key material.");

	const x = Buffer.from(base64UrlToBase64(publicKey.x), "base64");
	const y = Buffer.from(base64UrlToBase64(publicKey.y), "base64");
	return {
		publicKey: bytesToBase64Url(new Uint8Array(Buffer.concat([Buffer.from([0x04]), x, y]))),
		privateKey: privateKey.d,
	};
}

async function readWorkersSubdomain(accountId: string, accessToken: string) {
	try {
		const result = await readCloudflareApi<CloudflareWorkersSubdomain>(`/accounts/${accountId}/workers/subdomain`, accessToken);
		return result.subdomain ?? null;
	} catch {
		return null;
	}
}

async function writeVaultWranglerConfig(input: {
	accountId: string;
	scriptName: string;
	d1Name: string;
	d1Id: string;
	vapidPublicKey: string;
	vapidPrivateKey: string;
	vaultName: string;
}) {
	const config = {
		$schema: "node_modules/wrangler/config-schema.json",
		name: input.scriptName,
		account_id: input.accountId,
		main: "index.js",
		compatibility_date: "2026-06-06",
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		assets: {
			not_found_handling: "single-page-application",
			binding: "ASSETS",
			run_worker_first: ["/api/*"],
			directory: "../client",
		},
		vars: {
			VAPID_PUBLIC_KEY: input.vapidPublicKey,
			VAPID_PRIVATE_KEY: input.vapidPrivateKey,
			SICKRAT_VAULT_NAME: input.vaultName,
			SICKRAT_DEPLOYED_BY: "sickrat-cli",
		},
		observability: {
			enabled: true,
		},
		upload_source_maps: true,
		no_bundle: true,
		d1_databases: [
			{
				binding: "DB",
				database_name: input.d1Name,
				database_id: input.d1Id,
			},
		],
		durable_objects: {
			bindings: [
				{
					name: "APPROVAL_HUB",
					class_name: "ApprovalHub",
				},
			],
		},
		migrations: [
			{
				tag: "v1",
				new_sqlite_classes: ["ApprovalHub"],
			},
		],
	};
	const configPath = join(webWorkerBuildDir, `${input.scriptName}.wrangler.json`);
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return configPath;
}

async function deployVaultWorker(input: {
	accessToken: string;
	accountId: string;
	scriptName: string;
	d1Name: string;
	d1Id: string;
	vaultName: string;
}) {
	console.error("Building vault PWA and Worker bundle...");
	await runCommand("npm", ["--workspace", "apps/web", "run", "build"], { cwd: repoRoot });

	console.error("Generating vault-specific VAPID keys...");
	const vapid = await generateVapidKeys();
	const wranglerConfigPath = await writeVaultWranglerConfig({
		accountId: input.accountId,
		scriptName: input.scriptName,
		d1Name: input.d1Name,
		d1Id: input.d1Id,
		vapidPublicKey: vapid.publicKey,
		vapidPrivateKey: vapid.privateKey,
		vaultName: input.vaultName,
	});

	console.error(`Deploying private vault Worker ${input.scriptName}...`);
	await runCommand("npx", ["wrangler", "deploy", "--config", wranglerConfigPath], {
		cwd: webWorkerBuildDir,
		env: {
			...process.env,
			CLOUDFLARE_API_TOKEN: input.accessToken,
		},
	});
}

async function createVault(args: string[]) {
	const { cloudflare } = await ensureCloudflareConfig();
	const account = await chooseCloudflareAccount(cloudflare.accessToken, getArgValue(args, "--account-id"));
	const vaultArg = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--account-id");
	const vault = getVaultResourceNames(vaultArg);

	console.error(`Creating Sickrat vault "${vault.name}" in ${account.name} (${account.id})...`);
	const d1 = await ensureD1Database(account.id, cloudflare.accessToken, vault.d1Name);
	console.log(`D1\t${d1.created ? "created" : "exists"}\t${d1.database.name}\t${d1.database.uuid}`);

	await deployVaultWorker({
		accessToken: cloudflare.accessToken,
		accountId: account.id,
		scriptName: vault.scriptName,
		d1Name: vault.d1Name,
		d1Id: d1.database.uuid,
		vaultName: vault.name,
	});

	const subdomain = await readWorkersSubdomain(account.id, cloudflare.accessToken);
	const workerUrl = subdomain ? `https://${vault.scriptName}.${subdomain}.workers.dev` : `https://${vault.scriptName}.workers.dev`;
	const config = await readConfig();
	const nextVault = {
		name: vault.name,
		slug: vault.slug,
		accountId: account.id,
		accountName: account.name,
		scriptName: vault.scriptName,
		d1Name: vault.d1Name,
		d1Id: d1.database.uuid,
		workerUrl,
		createdAt: new Date().toISOString(),
	};
	const otherVaults = (config.vaults ?? []).filter((existing) => existing.accountId !== account.id || existing.slug !== vault.slug);
	await writeConfig({
		...config,
		workerUrl,
		vaults: [...otherVaults, nextVault],
	});

	console.log(`Worker\tdeployed\t${vault.scriptName}`);
	console.log(`Vault URL\t${workerUrl}`);
	console.error(`Open ${workerUrl} on your phone, add it to the Home Screen, then run:`);
	console.error(`  sickrat pair ${workerUrl}`);
}

async function pair(args: string[]) {
	const workerUrlArg = args[1];
	if (!workerUrlArg) usage(1);
	const workerUrl = normalizeWorkerUrl(workerUrlArg);
	const label = getArgValue(args, "--label") ?? hostname();
	const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const privateKey = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
	const pairing = await api<PairingCodeResponse>(workerUrl, "/api/devices/pairing-codes", {
		method: "POST",
		body: JSON.stringify({ label, publicKey }),
	});

	console.error(`Pairing code: ${pairing.code}`);
	console.error(`Open ${workerUrl}/?screen=pair and approve ${label}.`);
	console.error("Waiting for approval...");

	while (true) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		const status = await api<PairingCodeStatusResponse>(
			workerUrl,
			`/api/devices/pairing-codes/${pairing.code}/status`,
		);
		if (status.status === "expired") throw new Error("Pairing code expired.");
		if (status.status === "approved") {
			const config = await readConfig();
			await writeConfig({
				...config,
				workerUrl,
				deviceId: status.deviceId,
				label,
				signingPrivateKey: privateKey,
				signingPublicKey: publicKey,
				pairedAt: new Date().toISOString(),
			});
			console.error(`Paired ${label}. Config saved to ${configPath}.`);
			return;
		}
	}
}

async function signRequest(config: Config, input: Omit<ApprovalRequestCreate, "signature">) {
	if (!config.signingPrivateKey) throw new Error("No device signing key found. Run sickrat pair <worker-url> first.");
	const key = await crypto.subtle.importKey(
		"jwk",
		config.signingPrivateKey,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		textEncoder.encode(canonicalApprovalPayload(input)),
	);
	return bytesToBase64Url(normalizeEcdsaSignature(signature));
}

async function decryptGrant(grant: EncryptedGrant, privateKey: CryptoKey) {
	if (grant.alg !== "ECDH-P256-HKDF-SHA256-AES-256-GCM:v1") {
		throw new Error(`Unsupported grant algorithm: ${grant.alg}`);
	}
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		grant.ephemeralPublicKey,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const sharedSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
	const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
	const aesKey = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: grantWrapSalt, info: grantWrapInfo },
		hkdfKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlToBytes(grant.iv) },
		aesKey,
		base64UrlToBytes(grant.ciphertext),
	);
	return JSON.parse(textDecoder.decode(plaintext)) as GrantPayload;
}

async function requestSecret(args: string[]) {
	const ref = args.find((arg, index) => index > 0 && !arg.startsWith("-") && args[index - 1] !== "--message" && args[index - 1] !== "-m");
	if (!ref?.trim() || ref.trim() !== ref) usage(1);
	const message = getAnyArgValue(args, ["--message", "-m"]) ?? undefined;
	if (message !== undefined && (!message.trim() || message.trim() !== message || message.length > 600)) {
		throw new Error("Request message must be non-empty, 600 characters or fewer, and have no leading or trailing spaces.");
	}
	const config = await readConfig();
	if (!config.workerUrl || !config.deviceId) {
		throw new Error("No paired device config found. Run sickrat pair <worker-url> first.");
	}
	const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const ephemeralPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const unsigned = {
		deviceId: config.deviceId,
		command: `sickrat request ${ref}`,
		message,
		secretRefs: [ref],
		ephemeralPublicKey,
		timestamp: new Date().toISOString(),
		nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
	};
	const signature = await signRequest(config, unsigned);
	const created = await api<{ requestId: string; status: "pending" }>(config.workerUrl, "/api/approval-requests", {
		method: "POST",
		body: JSON.stringify({ ...unsigned, signature }),
	});
	console.error(`Approval request ${created.requestId} sent. Waiting for phone approval...`);

	const started = Date.now();
	while (Date.now() - started < 2 * 60 * 1000) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const result = await api<{
			status: "pending" | "approved" | "denied";
			grantCiphertext: EncryptedGrant | null;
		}>(config.workerUrl, `/api/approvals/${created.requestId}/grant`);
		if (result.status === "denied") throw new Error("Request denied.");
		if (result.status === "approved" && result.grantCiphertext) {
			const grant = await decryptGrant(result.grantCiphertext, keyPair.privateKey);
			const value = grant.secrets[ref];
			if (value === undefined) throw new Error(`Approved grant did not include ${ref}.`);
			process.stdout.write(value);
			return;
		}
	}

	throw new Error("Timed out waiting for approval.");
}

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];
	try {
		if (!command || command === "--help" || command === "-h") usage(0);
		if (command === "login") return await cloudflareLogin(args);
		if (command === "provision") return await createVault(args);
		if (command === "vault" && args[1] === "create") return await createVault(args.slice(1));
		if (command === "pair") return await pair(args);
		if (command === "request") return await requestSecret(args);
		usage(1);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

void main();
