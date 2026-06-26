#!/usr/bin/env bun
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { canonicalApprovalPayload, type ApprovalRequestCreate, type EncryptedGrant, type GrantPayload, type PairingCodeResponse, type PairingCodeStatusResponse } from "@sickrat/protocol";
import QRCode from "qrcode";

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
		vapidPublicKey?: string;
		vapidPrivateKey?: string;
	}>;
};

type GrantCache = {
	version: 1;
	entries: GrantCacheEntry[];
};

type GrantCacheEntry = {
	workerUrl: string;
	deviceId: string;
	refs: string[];
	secretsCiphertext: string;
	secretsIv: string;
	approvedAt: string;
	expiresAt: string;
	command: string;
	message?: string;
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

type CloudflareWorkerScriptSummary = {
	id: string;
	migration_tag?: string;
	created_on?: string;
	modified_on?: string;
};

type AssetManifest = Record<string, { hash: string; size: number }>;

type AssetFile = {
	manifestPath: string;
	filePath: string;
	hash: string;
	contentType: string;
};

type AssetUploadSession = {
	jwt: string;
	buckets: string[][];
};

type ConfiguredVault = NonNullable<Config["vaults"]>[number];

type VaultManifest = {
	manifestVersion: 1;
	vaultName: string;
	slug: string;
	sickratVersion: string;
	artifactVersion: string;
	schemaVersion: number;
	workerScriptName: string;
	workerUrl: string;
	resources: {
		d1: {
			databaseName: string;
			databaseId: string;
		};
		worker: {
			scriptName: string;
			workersDevUrl: string;
		};
		durableObjects: Array<{
			binding: string;
			className: string;
		}>;
		vars: string[];
		secrets: string[];
	};
	migrationsApplied: string[];
	lastUpdate: {
		startedAt: string;
		finishedAt: string;
		fromVersion: string;
		toVersion: string;
	} | null;
};

type GitHubRelease = {
	tag_name: string;
	html_url: string;
	assets: Array<{
		name: string;
		browser_download_url: string;
	}>;
};

type D1QueryResult<T> = {
	results?: T[];
	success?: boolean;
	meta?: unknown;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const configPath = join(homedir(), ".sickrat", "config.json");
const grantCachePath = join(homedir(), ".sickrat", "grant-cache.json");
const sourcePath = fileURLToPath(import.meta.url);
const grantWrapInfo = textEncoder.encode("sickrat:cli-grant:v1");
const grantWrapSalt = textEncoder.encode("sickrat:grant-ecdh:v1");
const defaultCloudflareClientId = "768469d277d474beaedd85115b63a81d";
const cliVersion = "0.1.23";
const releaseBaseUrl = "https://github.com/netanelgilad/sickrat/releases/download";

type WebArtifact = {
	workerDir: string;
	clientDir: string;
	build?: () => Promise<void>;
};

function resolveRepoRoot() {
	const starts = [
		process.env.SICKRAT_REPO_ROOT ? resolve(process.env.SICKRAT_REPO_ROOT) : null,
		resolve(dirname(sourcePath), "../../.."),
		resolve(dirname(process.execPath), "../../.."),
		process.cwd(),
	].filter((value): value is string => Boolean(value));

	for (const start of starts) {
		const found = findRepoRoot(start);
		if (found) return found;
	}

	return null;
}

function findRepoRoot(start: string) {
	let current = resolve(start);
	while (true) {
		const packageJsonPath = join(current, "package.json");
		if (existsSync(packageJsonPath) && existsSync(join(current, "apps/web"))) {
			try {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
				if (packageJson.name === "sickrat") return current;
			} catch {
				// Keep walking upward.
			}
		}

		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function resolveWebArtifact(): Promise<WebArtifact> {
	const explicitDist = process.env.SICKRAT_WEB_DIST ? resolve(process.env.SICKRAT_WEB_DIST) : null;
	if (explicitDist) {
		const workerDir = join(explicitDist, "sickrat");
		const clientDir = join(explicitDist, "client");
		if (existsSync(join(workerDir, "index.js")) && existsSync(join(clientDir, "index.html"))) {
			return { workerDir, clientDir };
		}
		throw new Error(`SICKRAT_WEB_DIST does not look like a Sickrat web artifact: ${explicitDist}`);
	}

	const repoRoot = resolveRepoRoot();
	if (repoRoot) {
		const webWorkspace = join(repoRoot, "apps/web");
		const workerDir = join(webWorkspace, "dist/sickrat");
		const clientDir = join(webWorkspace, "dist/client");
		return {
			workerDir,
			clientDir,
			build: () => runCommand("npm", ["--workspace", "apps/web", "run", "build"], { cwd: repoRoot }),
		};
	}

	return await downloadReleaseWebArtifact(cliVersion);
}

async function downloadReleaseWebArtifact(version: string, force = false): Promise<WebArtifact> {
	const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
	const cacheRoot = join(homedir(), ".sickrat", "artifacts", `web-v${normalizedVersion}`);
	const workerDir = join(cacheRoot, "sickrat");
	const clientDir = join(cacheRoot, "client");
	if (!force && existsSync(join(workerDir, "index.js")) && existsSync(join(clientDir, "index.html"))) {
		return { workerDir, clientDir };
	}

	await rm(cacheRoot, { recursive: true, force: true });
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
	const tempDir = await mkdtemp(join(tmpdir(), "sickrat-web-"));
	const archivePath = join(tempDir, "sickrat-web-dist.tar.gz");
	const tag = version.startsWith("v") ? version : `v${version}`;
	const url = `${releaseBaseUrl}/${tag}/sickrat-web-dist.tar.gz`;

	try {
		console.error(`Downloading Sickrat web artifact ${tag}...`);
		await downloadVerifiedReleaseAsset(tag, "sickrat-web-dist.tar.gz", archivePath);
		await runCommand("tar", ["-xzf", archivePath, "-C", cacheRoot]);
		if (!existsSync(join(workerDir, "index.js")) || !existsSync(join(clientDir, "index.html"))) {
			throw new Error("Downloaded web artifact is missing expected client/ or sickrat/ output.");
		}
		return { workerDir, clientDir };
	} catch (error) {
		await rm(cacheRoot, { recursive: true, force: true });
		throw new Error(
			`${error instanceof Error ? error.message : String(error)} Set SICKRAT_WEB_DIST to a local web artifact directory if you are using an unreleased CLI build.`,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function fetchLatestRelease() {
	const response = await fetch("https://api.github.com/repos/netanelgilad/sickrat/releases/latest", {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": `sickrat-cli/${cliVersion}`,
		},
	});
	if (!response.ok) throw new Error(`GitHub latest release lookup failed with HTTP ${response.status}.`);
	return (await response.json()) as GitHubRelease;
}

async function downloadUrlToFile(url: string, destination: string) {
	const response = await fetch(url, {
		headers: { "user-agent": `sickrat-cli/${cliVersion}` },
	});
	if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
	await writeFile(destination, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
}

async function sha256HexFile(path: string) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

async function downloadVerifiedReleaseAsset(tag: string, assetName: string, destination: string) {
	const base = `${releaseBaseUrl}/${tag}`;
	const tempDir = await mkdtemp(join(tmpdir(), "sickrat-download-"));
	const sumsPath = join(tempDir, "SHA256SUMS");
	try {
		await downloadUrlToFile(`${base}/SHA256SUMS`, sumsPath);
		const sums = await readFile(sumsPath, "utf8");
		const expected = sums
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
			.find((match) => match?.[2] === assetName)?.[1]
			?.toLowerCase();
		if (!expected) throw new Error(`SHA256SUMS does not contain ${assetName}.`);
		await downloadUrlToFile(`${base}/${assetName}`, destination);
		const actual = await sha256HexFile(destination);
		if (actual !== expected) {
			await rm(destination, { force: true });
			throw new Error(`Checksum mismatch for ${assetName}. Expected ${expected}, got ${actual}.`);
		}
		return { expected, actual };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function writeVaultUrlQrCode(workerUrl: string, slug: string) {
	const tempDir = await mkdtemp(join(tmpdir(), `sickrat-vault-${slug}-`));
	const qrPath = join(tempDir, "vault-url.png");
	await QRCode.toFile(qrPath, workerUrl, {
		type: "png",
		errorCorrectionLevel: "M",
		margin: 2,
		width: 1024,
	});
	return qrPath;
}

function printAndExit(output: string, exitCode = 0): never {
	(exitCode === 0 ? console.log : console.error)(output);
	process.exit(exitCode);
}

function usage(exitCode = 0): never {
	const output = `sickrat
Version: ${cliVersion}

Usage:
  sickrat login [--client-id <id>] [--port <port>]
  sickrat vault create [name] [--account-id <id>]
  sickrat vault status [name]
  sickrat vault update [name] [--dry-run] [--yes] [--force-unlock]
  sickrat self update [--yes]
  sickrat update [--yes]
  sickrat pair <worker-url> [--label <name>]
  sickrat run [--env KEY=ref] [--env-file <path>] [--message <why>] [--access-for <duration>] [--approval-timeout <duration>] -- <command...>
  sickrat reveal <ref> [--message <why>] [--approval-timeout <duration>]

Examples:
  sickrat login
  sickrat vault create personal
  sickrat vault status personal
  sickrat vault update personal --dry-run
  sickrat pair https://sickrat-personal.<your-subdomain>.workers.dev
  sickrat run --env SERVICE_TOKEN=service/api-token -- npm test
  sickrat run --env SERVICE_TOKEN=service/api-token --access-for 30m -- npm test
  sickrat run --env SERVICE_TOKEN=service/api-token --approval-timeout 15m -- npm test
  sickrat reveal service/api-token --message "Manual debug reveal"
`;
	printAndExit(output, exitCode);
}

function commandHelp(command: string): never {
	const help: Record<string, string> = {
		login: `sickrat login

Usage:
  sickrat login [--client-id <id>] [--port <port>]

Starts Cloudflare OAuth login and stores local control-plane state.
`,
		"vault create": `sickrat vault create

Usage:
  sickrat vault create [name] [--account-id <id>]

Creates or updates a user-owned Sickrat vault in the selected Cloudflare account.
`,
		"vault status": `sickrat vault status

Usage:
  sickrat vault status [name]

Shows the local and remote deployment status for a user-owned Sickrat vault.
`,
		"vault update": `sickrat vault update

Usage:
  sickrat vault update [name] [--dry-run] [--yes] [--force-unlock]

Updates a user-owned Sickrat vault Worker/PWA and deployment manifest using verified release artifacts.
`,
		"self update": `sickrat self update

Usage:
  sickrat self update [--yes]

Downloads, verifies, and atomically replaces the local Sickrat CLI binary when a newer release exists.
`,
		update: `sickrat update

Usage:
  sickrat update [--yes]

Updates the local CLI if needed, then updates the selected/default user-owned vault.
`,
		pair: `sickrat pair

Usage:
  sickrat pair <worker-url> [--label <name>]

Pairs this machine with an existing Sickrat vault after phone approval.
`,
		run: `sickrat run

Usage:
  sickrat run [--env KEY=ref] [--env-file <path>] [--message <why>] [--access-for <duration>] [--approval-timeout <duration>] -- <command...>

Requests phone approval for referenced secrets, injects approved values into the child process environment, and never prints secret values.
Use --access-for, for example 15m or 1h, to ask the user for a timed local grant that can be reused by later sickrat run calls until it expires.
Use --approval-timeout, for example 10m or 1h, when the CLI should wait longer for you to approve the current request.

Examples:
  sickrat run --env SERVICE_USERNAME=service/username --env SERVICE_PASSWORD=service/password -- npm run sync:service
  sickrat run --env SERVICE_TOKEN=service/api-token --access-for 30m -- npm run sync:service
  sickrat run --env SERVICE_TOKEN=service/api-token --approval-timeout 15m -- npm run sync:service
  sickrat run --env-file .env.sickrat -- npm run sync:service
`,
		reveal: `sickrat reveal

Usage:
  sickrat reveal <ref> [--message <why>] [--approval-timeout <duration>]

Requests a secret from a paired Sickrat vault and prints it to stdout. This is explicit manual/debug reveal mode.
`,
	};
	printAndExit(help[command] ?? "", help[command] ? 0 : 1);
}

function hasHelpFlag(args: string[]) {
	return args.includes("--help") || args.includes("-h");
}

function unknownCommand(command: string): never {
	printAndExit(`Unknown command: ${command}\nRun sickrat --help for usage.`, 1);
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

function getAllArgValues(args: string[], name: string) {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
	}
	return values;
}

function randomBase64Url(byteLength: number) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

function parseDuration(value: string | undefined, label: string) {
	if (!value) return undefined;
	const match = value.trim().match(/^(\d+)(s|m|h)?$/i);
	if (!match) throw new Error(`${label} must look like 10m, 1h, or 3600s.`);
	const amount = Number.parseInt(match[1], 10);
	const unit = (match[2] ?? "m").toLowerCase();
	const seconds = unit === "h" ? amount * 3600 : unit === "s" ? amount : amount * 60;
	if (!Number.isInteger(seconds) || seconds < 60 || seconds > 8 * 60 * 60) {
		throw new Error(`${label} must be between 1 minute and 8 hours.`);
	}
	return seconds;
}

function parseAccessDuration(value: string | undefined) {
	return parseDuration(value, "Access duration");
}

function parseApprovalTimeout(value: string | undefined) {
	return parseDuration(value, "Approval timeout");
}

function formatDuration(seconds: number) {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
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

async function readGrantCache() {
	try {
		const cache = JSON.parse(await readFile(grantCachePath, "utf8")) as GrantCache;
		return cache.version === 1 && Array.isArray(cache.entries) ? cache : ({ version: 1, entries: [] } satisfies GrantCache);
	} catch {
		return { version: 1, entries: [] } satisfies GrantCache;
	}
}

async function writeGrantCache(cache: GrantCache) {
	await mkdir(dirname(grantCachePath), { recursive: true, mode: 0o700 });
	await writeFile(grantCachePath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

async function deriveGrantCacheKey(config: Config) {
	const privateKeySeed = config.signingPrivateKey?.d;
	if (!privateKeySeed) throw new Error("No device signing key found. Run sickrat pair <worker-url> first.");
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(`sickrat:grant-cache:v1:${privateKeySeed}`));
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptCachedSecrets(secrets: Record<string, string>, key: CryptoKey) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(JSON.stringify(secrets)));
	return {
		secretsIv: bytesToBase64Url(iv),
		secretsCiphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
	};
}

async function decryptCachedSecrets(entry: GrantCacheEntry, key: CryptoKey) {
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlToBytes(entry.secretsIv) },
		key,
		base64UrlToBytes(entry.secretsCiphertext),
	);
	return JSON.parse(textDecoder.decode(plaintext)) as Record<string, string>;
}

async function findCachedGrant(input: { workerUrl: string; deviceId: string; refs: string[]; config: Config }) {
	const cache = await readGrantCache();
	const now = Date.now();
	const activeEntries = cache.entries.filter((entry) => Date.parse(entry.expiresAt) > now);
	if (activeEntries.length !== cache.entries.length) await writeGrantCache({ version: 1, entries: activeEntries });
	const key = await deriveGrantCacheKey(input.config);
	for (const entry of activeEntries) {
		if (entry.workerUrl !== input.workerUrl || entry.deviceId !== input.deviceId) continue;
		try {
			const secrets = await decryptCachedSecrets(entry, key);
			if (input.refs.every((ref) => secrets[ref] !== undefined)) return { entry, secrets };
		} catch {
			// Ignore stale cache entries that cannot be decrypted with the current device key.
		}
	}
	return null;
}

async function saveCachedGrant(entry: GrantCacheEntry) {
	if (Date.parse(entry.expiresAt) <= Date.now()) return;
	const cache = await readGrantCache();
	const nextEntries = cache.entries.filter((current) => {
		if (Date.parse(current.expiresAt) <= Date.now()) return false;
		if (current.workerUrl !== entry.workerUrl || current.deviceId !== entry.deviceId) return true;
		const currentRefs = current.refs.slice().sort().join("\n");
		const nextRefs = entry.refs.slice().sort().join("\n");
		return currentRefs !== nextRefs;
	});
	nextEntries.push(entry);
	await writeGrantCache({ version: 1, entries: nextEntries });
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

async function runChild(command: string, args: string[], env: NodeJS.ProcessEnv) {
	return await new Promise<number>((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${command} exited with signal ${signal}.`));
				return;
			}
			resolve(code ?? 1);
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

async function queryD1<T>(accountId: string, accessToken: string, databaseId: string, sql: string, params: unknown[] = []) {
	const result = await readCloudflareApi<D1QueryResult<T>[] | D1QueryResult<T>>(
		`/accounts/${accountId}/d1/database/${databaseId}/query`,
		accessToken,
		{
			method: "POST",
			body: JSON.stringify({ sql, params }),
		},
	);
	const first = Array.isArray(result) ? result[0] : result;
	if (first?.success === false) throw new Error(`D1 query failed: ${sql}`);
	return first?.results ?? [];
}

async function execD1(accountId: string, accessToken: string, databaseId: string, sql: string, params: unknown[] = []) {
	await queryD1(accountId, accessToken, databaseId, sql, params);
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
		let heartbeat: NodeJS.Timeout | null = null;
		const stopHeartbeat = () => {
			if (heartbeat) clearInterval(heartbeat);
			heartbeat = null;
		};
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
				stopHeartbeat();
				reject(new Error(requestUrl.searchParams.get("error_description") ?? error));
				return;
			}

			if (requestUrl.searchParams.get("state") !== state) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("Invalid OAuth state.");
				server.close();
				stopHeartbeat();
				reject(new Error("Cloudflare login returned an invalid OAuth state."));
				return;
			}

			const nextCode = requestUrl.searchParams.get("code");
			if (!nextCode) {
				response.writeHead(400, { "content-type": "text/plain" });
				response.end("Missing OAuth code.");
				server.close();
				stopHeartbeat();
				reject(new Error("Cloudflare login did not return an authorization code."));
				return;
			}

			response.writeHead(200, { "content-type": "text/plain" });
			response.end("Cloudflare login complete. You can return to your terminal.");
			server.close();
			stopHeartbeat();
			resolve(nextCode);
		});

		server.once("error", (error) => {
			stopHeartbeat();
			reject(error);
		});
		server.listen(port, "127.0.0.1", () => {
			console.error(`Opening Cloudflare login in your browser...`);
			console.error(`Cloudflare login URL: ${authUrl.toString()}`);
			console.error(`Callback: ${redirectUri}`);
			openBrowser(authUrl.toString());
			console.error("Waiting for browser authorization...");
			heartbeat = setInterval(() => {
				console.error(`Still waiting for Cloudflare authorization. If the browser did not open, use: ${authUrl.toString()}`);
			}, 10_000);
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
	console.error("Cloudflare login saved.");
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

function createVaultManifest(input: {
	vault: ConfiguredVault;
	version: string;
	fromVersion?: string;
	migrationsApplied?: string[];
	lastUpdateStartedAt?: string;
}) {
	const finishedAt = new Date().toISOString();
	return {
		manifestVersion: 1,
		vaultName: input.vault.name,
		slug: input.vault.slug,
		sickratVersion: input.version,
		artifactVersion: input.version,
		schemaVersion: 1,
		workerScriptName: input.vault.scriptName,
		workerUrl: input.vault.workerUrl,
		resources: {
			d1: {
				databaseName: input.vault.d1Name,
				databaseId: input.vault.d1Id,
			},
			worker: {
				scriptName: input.vault.scriptName,
				workersDevUrl: input.vault.workerUrl,
			},
			durableObjects: [{ binding: "APPROVAL_HUB", className: "ApprovalHub" }],
			vars: ["SICKRAT_VERSION", "SICKRAT_VAULT_NAME", "SICKRAT_DEPLOYED_BY", "VAPID_PUBLIC_KEY"],
			secrets: ["VAPID_PRIVATE_KEY"],
		},
		migrationsApplied: input.migrationsApplied ?? ["0001_manifest"],
		lastUpdate: input.fromVersion
			? {
					startedAt: input.lastUpdateStartedAt ?? finishedAt,
					finishedAt,
					fromVersion: input.fromVersion,
					toVersion: input.version,
				}
			: null,
	} satisfies VaultManifest;
}

async function ensureManifestTables(vault: ConfiguredVault, accessToken: string) {
	await execD1(
		vault.accountId,
		accessToken,
		vault.d1Id,
		"CREATE TABLE IF NOT EXISTS sickrat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
	);
	await execD1(
		vault.accountId,
		accessToken,
		vault.d1Id,
		"CREATE TABLE IF NOT EXISTS sickrat_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sickrat_version TEXT NOT NULL)",
	);
	await execD1(
		vault.accountId,
		accessToken,
		vault.d1Id,
		"CREATE TABLE IF NOT EXISTS sickrat_update_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL, from_version TEXT NOT NULL, to_version TEXT NOT NULL, last_completed_step TEXT)",
	);
}

async function readRemoteManifest(vault: ConfiguredVault, accessToken: string) {
	await ensureManifestTables(vault, accessToken);
	const rows = await queryD1<{ value: string }>(
		vault.accountId,
		accessToken,
		vault.d1Id,
		"SELECT value FROM sickrat_meta WHERE key = ? LIMIT 1",
		["deployment_manifest"],
	);
	if (!rows[0]?.value) return null;
	return JSON.parse(rows[0].value) as VaultManifest;
}

async function writeRemoteManifest(vault: ConfiguredVault, accessToken: string, manifest: VaultManifest) {
	await ensureManifestTables(vault, accessToken);
	await execD1(
		vault.accountId,
		accessToken,
		vault.d1Id,
		`INSERT INTO sickrat_meta (key, value, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		["deployment_manifest", JSON.stringify(manifest), new Date().toISOString()],
	);
	for (const migration of manifest.migrationsApplied) {
		await execD1(
			vault.accountId,
			accessToken,
			vault.d1Id,
			`INSERT INTO sickrat_migrations (id, applied_at, sickrat_version)
			 VALUES (?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
			[migration, new Date().toISOString(), manifest.sickratVersion],
		);
	}
}

async function acquireUpdateLock(vault: ConfiguredVault, accessToken: string, fromVersion: string, toVersion: string, forceUnlock: boolean) {
	await ensureManifestTables(vault, accessToken);
	const now = new Date();
	const existing = await queryD1<{ id: string; owner: string; expires_at: string; last_completed_step: string | null }>(
		vault.accountId,
		accessToken,
		vault.d1Id,
		"SELECT id, owner, expires_at, last_completed_step FROM sickrat_update_locks WHERE id = ? LIMIT 1",
		["vault-update"],
	);
	if (existing[0] && Date.parse(existing[0].expires_at) > now.getTime() && !forceUnlock) {
		throw new Error(
			`Vault update is already locked by ${existing[0].owner} until ${existing[0].expires_at}. Re-run with --force-unlock only if that update is abandoned.`,
		);
	}
	if (existing[0] && forceUnlock) {
		await execD1(vault.accountId, accessToken, vault.d1Id, "DELETE FROM sickrat_update_locks WHERE id = ?", ["vault-update"]);
	}
	const owner = `${hostname()}:${process.pid}`;
	const startedAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
	await execD1(
		vault.accountId,
		accessToken,
		vault.d1Id,
		`INSERT INTO sickrat_update_locks (id, owner, started_at, expires_at, from_version, to_version, last_completed_step)
		 VALUES (?, ?, ?, ?, ?, ?, NULL)
		 ON CONFLICT(id) DO UPDATE SET
			owner = excluded.owner,
			started_at = excluded.started_at,
			expires_at = excluded.expires_at,
			from_version = excluded.from_version,
			to_version = excluded.to_version,
			last_completed_step = NULL`,
		["vault-update", owner, startedAt, expiresAt, fromVersion, toVersion],
	);
	return { owner, startedAt };
}

async function markUpdateStep(vault: ConfiguredVault, accessToken: string, step: string) {
	await execD1(
		vault.accountId,
		accessToken,
		vault.d1Id,
		"UPDATE sickrat_update_locks SET last_completed_step = ? WHERE id = ?",
		[step, "vault-update"],
	);
}

async function releaseUpdateLock(vault: ConfiguredVault, accessToken: string) {
	await execD1(vault.accountId, accessToken, vault.d1Id, "DELETE FROM sickrat_update_locks WHERE id = ?", ["vault-update"]);
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

async function readWorkerMigrationTag(accountId: string, accessToken: string, scriptName: string) {
	try {
		const scripts = await readCloudflareApi<CloudflareWorkerScriptSummary[]>(`/accounts/${accountId}/workers/scripts`, accessToken);
		return scripts.find((script) => script.id === scriptName)?.migration_tag ?? null;
	} catch {
		return null;
	}
}

async function enableWorkerSubdomain(accountId: string, accessToken: string, scriptName: string) {
	await readCloudflareApi<unknown>(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, accessToken, {
		method: "POST",
		body: JSON.stringify({ enabled: true }),
	});
}

function contentTypeForPath(path: string) {
	const extension = extname(path).toLowerCase();
	switch (extension) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
		case ".webmanifest":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".ico":
			return "image/x-icon";
		case ".txt":
			return "text/plain; charset=utf-8";
		default:
			return "application/null";
	}
}

async function listAssetFiles(clientDir: string) {
	const files: AssetFile[] = [];

	async function walk(directory: string) {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			const filePath = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(filePath);
				continue;
			}
			if (!entry.isFile()) continue;

			const relativePath = relative(clientDir, filePath).replace(/\\/g, "/");
			if (relativePath === ".assetsignore") continue;
			const bytes = await readFile(filePath);
			const extension = extname(relativePath).slice(1);
			const hash = createHash("sha256").update(bytes.toString("base64") + extension).digest("hex").slice(0, 32);
			files.push({
				manifestPath: `/${relativePath}`,
				filePath,
				hash,
				contentType: contentTypeForPath(relativePath),
			});
		}
	}

	await walk(clientDir);
	if (files.length === 0) throw new Error(`No web assets found in ${clientDir}.`);
	return files;
}

function createAssetManifest(files: AssetFile[]) {
	const manifest: AssetManifest = {};
	for (const file of files) {
		manifest[file.manifestPath] = {
			hash: file.hash,
			size: readFileSync(file.filePath).byteLength,
		};
	}
	return manifest;
}

async function uploadVaultAssets(input: {
	accessToken: string;
	accountId: string;
	scriptName: string;
	clientDir: string;
}) {
	const files = await listAssetFiles(input.clientDir);
	const manifest = createAssetManifest(files);
	const session = await readCloudflareApi<AssetUploadSession>(
		`/accounts/${input.accountId}/workers/scripts/${input.scriptName}/assets-upload-session`,
		input.accessToken,
		{
			method: "POST",
			body: JSON.stringify({ manifest }),
		},
	);

	if (!session.jwt) throw new Error("Cloudflare did not return an asset upload token.");
	if (session.buckets.flat().length === 0) return session.jwt;

	const filesByHash = new Map(files.map((file) => [file.hash, file]));
	let completionJwt = "";
	for (const bucket of session.buckets) {
		const formData = new FormData();
		for (const hash of bucket) {
			const file = filesByHash.get(hash);
			if (!file) throw new Error(`Cloudflare requested unknown asset hash ${hash}.`);
			formData.append(hash, new Blob([(await readFile(file.filePath)).toString("base64")], { type: file.contentType }), hash);
		}

		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/assets/upload?base64=true`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${session.jwt}`,
			},
			body: formData,
		});
		const body = (await response.json().catch(() => null)) as {
			success?: boolean;
			result?: { jwt?: string };
			errors?: Array<{ message: string }>;
		} | null;
		if (!response.ok || !body?.success) {
			const message = body?.errors?.map((error) => error.message).join("; ") || `Cloudflare asset upload returned HTTP ${response.status}`;
			throw new Error(message);
		}
		if (body.result?.jwt) completionJwt = body.result.jwt;
	}

	if (!completionJwt) throw new Error("Cloudflare asset upload completed without returning a completion token.");
	return completionJwt;
}

async function uploadVaultWorker(input: {
	accessToken: string;
	accountId: string;
	scriptName: string;
	d1Id: string;
	vaultName: string;
	sickratVersion: string;
	vapidPublicKey: string;
	vapidPrivateKey: string;
	assetsJwt: string;
	workerDir: string;
}) {
	const workerPath = join(input.workerDir, "index.js");
	const workerSource = await readFile(workerPath);
	const migrationTag = await readWorkerMigrationTag(input.accountId, input.accessToken, input.scriptName);
	const metadata = {
		main_module: "index.js",
		compatibility_date: "2026-06-06",
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		assets: {
			jwt: input.assetsJwt,
			config: {
				not_found_handling: "single-page-application",
				run_worker_first: ["/api/*"],
			},
		},
		bindings: [
			{ name: "ASSETS", type: "assets" },
			{ name: "DB", type: "d1", id: input.d1Id },
			{ name: "APPROVAL_HUB", type: "durable_object_namespace", class_name: "ApprovalHub" },
			{ name: "VAPID_PUBLIC_KEY", type: "plain_text", text: input.vapidPublicKey },
			{ name: "VAPID_PRIVATE_KEY", type: "secret_text", text: input.vapidPrivateKey },
			{ name: "SICKRAT_VAULT_NAME", type: "plain_text", text: input.vaultName },
			{ name: "SICKRAT_DEPLOYED_BY", type: "plain_text", text: "sickrat-cli" },
			{ name: "SICKRAT_VERSION", type: "plain_text", text: input.sickratVersion },
		],
		...(migrationTag === "v1"
			? {}
			: {
					migrations: {
						...(migrationTag ? { old_tag: migrationTag } : {}),
						new_tag: "v1",
						steps: [{ new_sqlite_classes: ["ApprovalHub"] }],
					},
				}),
		observability: {
			enabled: true,
		},
	};

	const formData = new FormData();
	formData.set("metadata", JSON.stringify(metadata));
	formData.append("index.js", new Blob([workerSource], { type: "application/javascript+module" }), "index.js");

	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${input.scriptName}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${input.accessToken}`,
		},
		body: formData,
	});
	const body = (await response.json().catch(() => null)) as {
		success?: boolean;
		errors?: Array<{ message: string }>;
	} | null;
	if (!response.ok || !body?.success) {
		const message = body?.errors?.map((error) => error.message).join("; ") || `Cloudflare Worker upload returned HTTP ${response.status}`;
		throw new Error(message);
	}
}

async function deployVaultWorker(input: {
	accessToken: string;
	accountId: string;
	scriptName: string;
	d1Id: string;
	vaultName: string;
	version?: string;
	artifact?: WebArtifact;
	vapid?: { publicKey: string; privateKey: string };
}) {
	const version = input.version ?? cliVersion;
	const artifact = input.artifact ?? (await resolveWebArtifact());
	console.error("Preparing vault PWA and Worker bundle...");
	if (artifact.build) await artifact.build();

	const vapid = input.vapid ?? (await generateVapidKeys());
	if (input.vapid) {
		console.error("Reusing vault VAPID keys...");
	} else {
		console.error("Generated vault-specific VAPID keys.");
	}
	console.error("Uploading vault PWA assets...");
	const assetsJwt = await uploadVaultAssets({
		accessToken: input.accessToken,
		accountId: input.accountId,
		scriptName: input.scriptName,
		clientDir: artifact.clientDir,
	});

	console.error(`Deploying private vault Worker ${input.scriptName}...`);
	try {
		await uploadVaultWorker({
			accessToken: input.accessToken,
			accountId: input.accountId,
			scriptName: input.scriptName,
			d1Id: input.d1Id,
			vaultName: input.vaultName,
			sickratVersion: version,
			vapidPublicKey: vapid.publicKey,
			vapidPrivateKey: vapid.privateKey,
			assetsJwt,
			workerDir: artifact.workerDir,
		});
		await enableWorkerSubdomain(input.accountId, input.accessToken, input.scriptName);
		return vapid;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const context = /migration|migrations|unmarshal/i.test(message)
			? "Worker deployment failed while applying Durable Object migration metadata"
			: "Worker deployment failed";
		throw new Error(`${context}: ${message}`);
	}
}

async function createVault(args: string[]) {
	const { cloudflare } = await ensureCloudflareConfig();
	const account = await chooseCloudflareAccount(cloudflare.accessToken, getArgValue(args, "--account-id"));
	const vaultArg = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--account-id");
	const vault = getVaultResourceNames(vaultArg);

	console.error(`Creating Sickrat vault "${vault.name}" in ${account.name} (${account.id})...`);
	const d1 = await ensureD1Database(account.id, cloudflare.accessToken, vault.d1Name);
	console.log(`D1\t${d1.created ? "created" : "exists"}\t${d1.database.name}\t${d1.database.uuid}`);

	const vapid = await deployVaultWorker({
		accessToken: cloudflare.accessToken,
		accountId: account.id,
		scriptName: vault.scriptName,
		d1Id: d1.database.uuid,
		vaultName: vault.name,
		version: cliVersion,
	});

	const subdomain = await readWorkersSubdomain(account.id, cloudflare.accessToken);
	const workerUrl = subdomain ? `https://${vault.scriptName}.${subdomain}.workers.dev` : `https://${vault.scriptName}.workers.dev`;
	const qrPath = await writeVaultUrlQrCode(workerUrl, vault.slug);
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
		vapidPublicKey: vapid.publicKey,
		vapidPrivateKey: vapid.privateKey,
	};
	await writeRemoteManifest(nextVault, cloudflare.accessToken, createVaultManifest({ vault: nextVault, version: cliVersion }));
	const otherVaults = (config.vaults ?? []).filter((existing) => existing.accountId !== account.id || existing.slug !== vault.slug);
	await writeConfig({
		...config,
		workerUrl,
		vaults: [...otherVaults, nextVault],
	});

	console.log(`Worker\tdeployed\t${vault.scriptName}`);
	console.log(`Vault URL\t${workerUrl}`);
	console.log(`Vault QR\t${qrPath}`);
	console.error(`Open ${workerUrl} on your phone, add it to the Home Screen, enable push notifications, then run:`);
	console.error(`  sickrat pair ${workerUrl}`);
}

async function discoverConfiguredVaults(accessToken: string) {
	const accounts = await readCloudflareApi<CloudflareAccount[]>("/accounts?per_page=50", accessToken);
	const discovered: ConfiguredVault[] = [];
	for (const account of accounts) {
		const [scripts, databases, subdomain] = await Promise.all([
			readCloudflareApi<CloudflareWorkerScriptSummary[]>(`/accounts/${account.id}/workers/scripts`, accessToken).catch(() => []),
			readCloudflareApi<CloudflareD1Database[]>(`/accounts/${account.id}/d1/database?per_page=100`, accessToken).catch(() => []),
			readWorkersSubdomain(account.id, accessToken),
		]);
		for (const script of scripts.filter((candidate) => candidate.id.startsWith("sickrat-"))) {
			const slug = script.id.replace(/^sickrat-/, "");
			if (!slug) continue;
			const d1Name = `sickrat-${slug}-vault`;
			const database = databases.find((candidate) => candidate.name === d1Name);
			if (!database) continue;
			const workerUrl = subdomain ? `https://${script.id}.${subdomain}.workers.dev` : `https://${script.id}.workers.dev`;
			discovered.push({
				name: slug,
				slug,
				accountId: account.id,
				accountName: account.name,
				scriptName: script.id,
				d1Name,
				d1Id: database.uuid,
				workerUrl,
				createdAt: script.created_on ?? database.created_at ?? new Date().toISOString(),
			});
		}
	}
	return discovered.sort((left, right) => left.scriptName.localeCompare(right.scriptName));
}

async function selectConfiguredVault(config: Config, accessToken: string, name?: string | null) {
	const vaults = config.vaults ?? [];
	if (name) {
		const normalized = normalizeVaultName(name);
		const selected = vaults.find((vault) => vault.slug === normalized.slug || vault.name === name || vault.scriptName === name);
		if (selected) return selected;
		const discovered = await discoverConfiguredVaults(accessToken);
		const discoveredSelected = discovered.find((vault) => vault.slug === normalized.slug || vault.name === name || vault.scriptName === name);
		if (discoveredSelected) return discoveredSelected;
		throw new Error(`Vault not found: ${name}`);
	}
	if (vaults.length > 0) {
		const selected = config.workerUrl ? vaults.find((vault) => vault.workerUrl === config.workerUrl) : null;
		return selected ?? vaults.at(-1) ?? vaults[0];
	}
	const discovered = await discoverConfiguredVaults(accessToken);
	if (discovered.length === 0) throw new Error("No Sickrat vaults found. Run sickrat vault create first.");
	if (discovered.length === 1) return discovered[0];
	throw new Error(`Multiple Sickrat vaults found. Re-run with a vault name: ${discovered.map((vault) => vault.name).join(", ")}`);
}

function compareSemver(a: string, b: string) {
	const left = a.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function releaseVersion(release: GitHubRelease) {
	return release.tag_name.replace(/^v/, "");
}

async function vaultStatus(args: string[]) {
	const { config, cloudflare } = await ensureCloudflareConfig();
	const vaultName = args.find((arg, index) => index > 1 && !arg.startsWith("-") && args[index - 1] !== "--account-id");
	const vault = await selectConfiguredVault(config, cloudflare.accessToken, vaultName);
	const manifest = await readRemoteManifest(vault, cloudflare.accessToken).catch((error) => {
		console.error(`Remote manifest unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	});
	const capabilities = await fetch(`${vault.workerUrl}/api/capabilities`).then((response) => response.json()).catch(() => null) as
		| { vault?: { version?: string; name?: string; deployedBy?: string }; database?: { configured?: boolean }; push?: { configured?: boolean } }
		| null;
	const latest = await fetchLatestRelease().catch(() => null);
	const currentVersion = manifest?.sickratVersion ?? capabilities?.vault?.version ?? "unknown";
	const latestVersion = latest ? releaseVersion(latest) : "unknown";
	console.log(`Vault\t${vault.name}`);
	console.log(`URL\t${vault.workerUrl}`);
	console.log(`Account\t${vault.accountName}\t${vault.accountId}`);
	console.log(`Worker\t${vault.scriptName}`);
	console.log(`D1\t${vault.d1Name}\t${vault.d1Id}`);
	console.log(`Current\t${currentVersion}`);
	console.log(`Latest\t${latestVersion}`);
	console.log(`Manifest\t${manifest ? "present" : "missing"}`);
	console.log(`Push\t${capabilities?.push?.configured ? "configured" : "unknown"}`);
	console.log(`Database\t${capabilities?.database?.configured ? "configured" : "unknown"}`);
	if (latest && currentVersion !== "unknown") {
		console.log(`Update\t${compareSemver(currentVersion, latestVersion) < 0 ? "available" : "not-needed"}`);
	}
}

function platformReleaseAssetName() {
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
	if (process.platform === "darwin") return `sickrat-darwin-${arch}`;
	if (process.platform === "linux") return `sickrat-linux-${arch}`;
	throw new Error(`Sickrat self-update does not support this platform yet: ${process.platform}/${process.arch}`);
}

async function selfUpdate(args: string[]) {
	const yes = args.includes("--yes");
	const release = await fetchLatestRelease();
	const latestVersion = releaseVersion(release);
	if (compareSemver(cliVersion, latestVersion) >= 0) {
		console.log(`Sickrat CLI is current (${cliVersion}).`);
		return;
	}
	const assetName = platformReleaseAssetName();
	if (!release.assets.some((asset) => asset.name === assetName)) throw new Error(`Release ${release.tag_name} does not include ${assetName}.`);
	const currentPath = process.execPath;
	await stat(currentPath).catch(() => {
		throw new Error(`Cannot stat current executable: ${currentPath}`);
	});
	if (!yes && process.stdin.isTTY) {
		const readline = createInterface({ input: process.stdin, output: process.stderr });
		try {
			const answer = await readline.question(`Update Sickrat CLI ${cliVersion} -> ${latestVersion} at ${currentPath}? [y/N] `);
			if (!/^y(es)?$/i.test(answer.trim())) {
				console.error("Self-update cancelled.");
				return;
			}
		} finally {
			readline.close();
		}
	}
	const tempDir = await mkdtemp(join(tmpdir(), "sickrat-self-update-"));
	const nextPath = join(tempDir, assetName);
	const backupPath = `${currentPath}.bak-${Date.now()}`;
	try {
		console.error(`Downloading ${assetName} from ${release.tag_name}...`);
		await downloadVerifiedReleaseAsset(release.tag_name, assetName, nextPath);
		await chmod(nextPath, 0o755);
		const versionCheck = await new Promise<string>((resolve, reject) => {
			const child = spawn(nextPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout?.on("data", (chunk) => (output += chunk.toString()));
			child.once("error", reject);
			child.once("exit", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error("Downloaded binary failed --version check."))));
		});
		if (versionCheck !== latestVersion) throw new Error(`Downloaded binary reports ${versionCheck}, expected ${latestVersion}.`);
		await rename(currentPath, backupPath);
		try {
			await rename(nextPath, currentPath);
		} catch (error) {
			await rename(backupPath, currentPath).catch(() => undefined);
			throw error;
		}
		await rm(backupPath, { force: true });
		console.log(`Updated Sickrat CLI to ${latestVersion}.`);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function vaultUpdate(args: string[]) {
	const { config, cloudflare } = await ensureCloudflareConfig();
	const dryRun = args.includes("--dry-run");
	const yes = args.includes("--yes") || dryRun;
	const forceUnlock = args.includes("--force-unlock");
	const vaultName = args.find((arg, index) => index > 1 && !arg.startsWith("-") && !["--account-id"].includes(args[index - 1]));
	const vault = await selectConfiguredVault(config, cloudflare.accessToken, vaultName);
	const release = await fetchLatestRelease();
	const targetVersion = releaseVersion(release);
	const existingManifest = await readRemoteManifest(vault, cloudflare.accessToken).catch(() => null);
	const currentVersion = existingManifest?.sickratVersion ?? "unknown";
	const needsVersionUpdate = currentVersion === "unknown" || compareSemver(currentVersion, targetVersion) < 0;
	const needsManifest = !existingManifest;
	const willRotateVapid = !vault.vapidPublicKey || !vault.vapidPrivateKey;
	const plan = [
		...(needsManifest ? ["initialize remote deployment manifest"] : []),
		...(needsVersionUpdate ? [`deploy Worker/PWA artifact ${targetVersion}`] : []),
		"ensure D1 manifest and migration tables",
		...(willRotateVapid ? ["rotate VAPID push keys and require PWA push refresh"] : ["preserve VAPID push keys"]),
		"verify /api/capabilities",
		"write deployment manifest",
	];
	console.log(`Sickrat vault update: ${vault.name}`);
	console.log(`Current vault: ${currentVersion}`);
	console.log(`Target vault:  ${targetVersion}`);
	console.log("");
	console.log("Plan:");
	for (const item of plan) console.log(`  - ${item}`);
	if (dryRun) return;
	if (!yes && process.stdin.isTTY) {
		const readline = createInterface({ input: process.stdin, output: process.stderr });
		try {
			const answer = await readline.question("Apply update? [y/N] ");
			if (!/^y(es)?$/i.test(answer.trim())) {
				console.error("Vault update cancelled.");
				return;
			}
		} finally {
			readline.close();
		}
	}
	const lock = await acquireUpdateLock(vault, cloudflare.accessToken, currentVersion, targetVersion, forceUnlock);
	try {
		await ensureManifestTables(vault, cloudflare.accessToken);
		await markUpdateStep(vault, cloudflare.accessToken, "ensure_manifest_tables");
		const artifact = await downloadReleaseWebArtifact(targetVersion, true);
		await markUpdateStep(vault, cloudflare.accessToken, "download_artifact");
		const vapid = await deployVaultWorker({
			accessToken: cloudflare.accessToken,
			accountId: vault.accountId,
			scriptName: vault.scriptName,
			d1Id: vault.d1Id,
			vaultName: vault.name,
			version: targetVersion,
			artifact,
			vapid: vault.vapidPublicKey && vault.vapidPrivateKey ? { publicKey: vault.vapidPublicKey, privateKey: vault.vapidPrivateKey } : undefined,
		});
		await markUpdateStep(vault, cloudflare.accessToken, "deploy_worker");
		const response = await fetch(`${vault.workerUrl}/api/capabilities`);
		if (!response.ok) throw new Error(`Updated Worker health check failed with HTTP ${response.status}.`);
		const manifest = createVaultManifest({
			vault,
			version: targetVersion,
			fromVersion: currentVersion,
			migrationsApplied: Array.from(new Set([...(existingManifest?.migrationsApplied ?? []), "0001_manifest", `deploy_${targetVersion}`])),
			lastUpdateStartedAt: lock.startedAt,
		});
		await writeRemoteManifest(vault, cloudflare.accessToken, manifest);
		await markUpdateStep(vault, cloudflare.accessToken, "write_manifest");
		const nextVault = { ...vault, vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey };
		const otherVaults = (config.vaults ?? []).filter((existing) => existing.accountId !== vault.accountId || existing.slug !== vault.slug);
		await writeConfig({ ...config, workerUrl: vault.workerUrl, vaults: [...otherVaults, nextVault] });
		await releaseUpdateLock(vault, cloudflare.accessToken);
		console.log(`Vault ${vault.name} updated to ${targetVersion}.`);
		if (willRotateVapid) {
			console.log("Push keys were rotated for this legacy vault. Open the installed PWA Settings page and refresh push if notifications do not arrive.");
		}
	} catch (error) {
		console.error("Vault update failed. The update lock remains for inspection or --force-unlock retry.");
		throw error;
	}
}

async function updateAll(args: string[]) {
	await selfUpdate(args);
	await vaultUpdate(["vault", "update", ...args.slice(1)]);
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
	console.error(`Expires: ${new Date(pairing.expiresAt).toLocaleString()}`);
	console.error(`A pairing notification was sent if push is enabled. Otherwise open ${workerUrl}/devices and enter the code.`);
	console.error("Waiting for approval...");

	let lastHeartbeatAt = 0;
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
			console.error(`Paired ${label}.`);
			return;
		}
		const now = Date.now();
		if (now - lastHeartbeatAt > 10_000) {
			const remainingMs = Math.max(0, Date.parse(pairing.expiresAt) - now);
			const remainingSeconds = Math.ceil(remainingMs / 1000);
			console.error(`Still waiting for phone approval. Pairing expires in ${remainingSeconds}s.`);
			lastHeartbeatAt = now;
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

function validateRequestMessage(message: string | undefined) {
	if (message !== undefined && (!message.trim() || message.trim() !== message || message.length > 600)) {
		throw new Error("Request message must be non-empty, 600 characters or fewer, and have no leading or trailing spaces.");
	}
}

function uniqueRefs(refs: string[]) {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		if (!ref.trim() || ref.trim() !== ref) throw new Error(`Invalid Sickrat reference: ${ref}`);
		if (seen.has(ref)) continue;
		seen.add(ref);
		unique.push(ref);
	}
	if (unique.length === 0) throw new Error("At least one Sickrat reference is required.");
	return unique;
}

async function requestGrant(input: { refs: string[]; message?: string; command: string; accessDurationSeconds?: number; approvalWaitSeconds?: number; allowCache?: boolean }) {
	validateRequestMessage(input.message);
	const refs = uniqueRefs(input.refs);
	const approvalWaitSeconds = input.approvalWaitSeconds ?? 2 * 60;
	const config = await readConfig();
	if (!config.workerUrl || !config.deviceId) {
		throw new Error("No paired device config found. Run sickrat pair <worker-url> first.");
	}
	if (input.allowCache !== false) {
		const cached = await findCachedGrant({ workerUrl: config.workerUrl, deviceId: config.deviceId, refs, config });
		if (cached) {
			console.error(`Using timed local grant approved until ${cached.entry.expiresAt}.`);
			return {
				secrets: cached.secrets,
				approvedAt: cached.entry.approvedAt,
				accessExpiresAt: cached.entry.expiresAt,
			} satisfies GrantPayload;
		}
	}
	const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const ephemeralPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const unsigned = {
		deviceId: config.deviceId,
		command: input.command,
		message: input.message,
		secretRefs: refs,
		accessDurationSeconds: input.accessDurationSeconds,
		approvalWaitSeconds,
		ephemeralPublicKey,
		timestamp: new Date().toISOString(),
		nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
	};
	const signature = await signRequest(config, unsigned);
	const created = await api<{ requestId: string; status: "pending" }>(config.workerUrl, "/api/approval-requests", {
		method: "POST",
		body: JSON.stringify({ ...unsigned, signature }),
	});
	console.error(
		input.accessDurationSeconds
			? `Timed access request ${created.requestId} sent for ${formatDuration(input.accessDurationSeconds)}. Waiting for phone approval...`
			: `Approval request ${created.requestId} sent. Waiting for phone approval...`,
	);
	if (approvalWaitSeconds !== 2 * 60) {
		console.error(`CLI will wait up to ${formatDuration(approvalWaitSeconds)} for approval.`);
	}
	console.error(`Requested refs: ${refs.join(", ")}`);
	console.error(`If the notification does not appear, open ${config.workerUrl}/approve/${encodeURIComponent(created.requestId)} on your phone.`);

	const started = Date.now();
	let lastHeartbeatAt = 0;
	const approvalWaitMs = approvalWaitSeconds * 1000;
	while (Date.now() - started < approvalWaitMs) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const result = await api<{
			status: "pending" | "approved" | "denied";
			grantCiphertext: EncryptedGrant | null;
			accessExpiresAt?: string | null;
		}>(config.workerUrl, `/api/approvals/${created.requestId}/grant`);
		if (result.status === "denied") throw new Error("Request denied.");
		if (result.status === "approved" && result.grantCiphertext) {
			const grant = await decryptGrant(result.grantCiphertext, keyPair.privateKey);
			for (const ref of refs) {
				if (grant.secrets[ref] === undefined) throw new Error(`Approved grant did not include ${ref}.`);
			}
			if (grant.accessExpiresAt && Date.parse(grant.accessExpiresAt) > Date.now()) {
				const cacheKey = await deriveGrantCacheKey(config);
				const encrypted = await encryptCachedSecrets(grant.secrets, cacheKey);
				await saveCachedGrant({
					workerUrl: config.workerUrl,
					deviceId: config.deviceId,
					refs,
					...encrypted,
					approvedAt: grant.approvedAt,
					expiresAt: grant.accessExpiresAt,
					command: input.command,
					message: input.message,
				});
				console.error(`Approved. Timed local grant cached until ${grant.accessExpiresAt}.`);
				return grant;
			}
			console.error("Approved. Grant received.");
			return grant;
		}
		const now = Date.now();
		if (now - lastHeartbeatAt > 10_000) {
			const remainingSeconds = Math.max(0, Math.ceil((approvalWaitMs - (now - started)) / 1000));
			console.error(
				`Still waiting for phone approval. CLI wait ends in ${remainingSeconds}s. Fallback: ${config.workerUrl}/approve/${encodeURIComponent(created.requestId)}`,
			);
			lastHeartbeatAt = now;
		}
	}

	throw new Error("Timed out waiting for approval.");
}

async function revealSecret(args: string[]) {
	const ref = args.find((arg, index) => index > 0 && !arg.startsWith("-") && args[index - 1] !== "--message" && args[index - 1] !== "-m" && args[index - 1] !== "--approval-timeout");
	if (!ref?.trim() || ref.trim() !== ref) commandHelp("reveal");
	const message = getAnyArgValue(args, ["--message", "-m"]) ?? undefined;
	const approvalWaitSeconds = parseApprovalTimeout(getAnyArgValue(args, ["--approval-timeout"]) ?? undefined);
	for (let index = 1; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--message" || arg === "-m" || arg === "--approval-timeout") {
			index += 1;
			continue;
		}
		if (arg !== ref) throw new Error(`Unknown sickrat reveal option: ${arg}`);
	}
	const grant = await requestGrant({
		refs: [ref],
		message,
		approvalWaitSeconds,
		command: `sickrat reveal ${ref}`,
		allowCache: false,
	});
	process.stdout.write(grant.secrets[ref] ?? "");
}

function parseEnvAssignment(value: string) {
	const match = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
	if (!match) throw new Error(`Expected KEY=value, got: ${value}`);
	return { key: match[1], value: match[2] };
}

function unquoteDotenvValue(value: string) {
	const trimmed = value.trim();
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	const commentIndex = trimmed.search(/\s#/);
	return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}

function parseDotenv(content: string, path: string) {
	const values: Record<string, string> = {};
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
		const equalIndex = withoutExport.indexOf("=");
		if (equalIndex <= 0) throw new Error(`${path}:${index + 1}: expected KEY=value`);
		const key = withoutExport.slice(0, equalIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${path}:${index + 1}: invalid env key ${key}`);
		values[key] = unquoteDotenvValue(withoutExport.slice(equalIndex + 1));
	}
	return values;
}

function sickratUriToRef(value: string) {
	if (!value.startsWith("sickrat://")) return null;
	const url = new URL(value);
	const ref = `${url.hostname}${url.pathname}`.replace(/^\/+|\/+$/g, "");
	if (!ref) throw new Error(`Invalid Sickrat reference URI: ${value}`);
	return decodeURIComponent(ref);
}

function formatCommand(commandArgs: string[]) {
	return commandArgs
		.map((arg) => (/^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg)))
		.join(" ");
}

async function runWithSecrets(args: string[]) {
	const separatorIndex = args.indexOf("--");
	if (separatorIndex < 0 || separatorIndex === args.length - 1) commandHelp("run");
	const beforeCommand = args.slice(1, separatorIndex);
	const commandArgs = args.slice(separatorIndex + 1);
	const directEnv = getAllArgValues(beforeCommand, "--env").map(parseEnvAssignment);
	const envFiles = getAllArgValues(beforeCommand, "--env-file");
	const message = getAnyArgValue(beforeCommand, ["--message", "-m"]) ?? undefined;
	const accessDurationSeconds = parseAccessDuration(getAnyArgValue(beforeCommand, ["--access-for"]) ?? undefined);
	const approvalWaitSeconds = parseApprovalTimeout(getAnyArgValue(beforeCommand, ["--approval-timeout"]) ?? undefined);
	validateRequestMessage(message);

	for (let index = 0; index < beforeCommand.length; index += 1) {
		const arg = beforeCommand[index];
		if (arg === "--env" || arg === "--env-file" || arg === "--message" || arg === "-m" || arg === "--access-for" || arg === "--approval-timeout") {
			index += 1;
			continue;
		}
		throw new Error(`Unknown sickrat run option: ${arg}`);
	}

	const env: NodeJS.ProcessEnv = { ...process.env };
	const refByKey = new Map<string, string>();
	const preservedEnvFileKeys = new Set<string>();
	for (const envFile of envFiles) {
		const parsed = parseDotenv(await readFile(envFile, "utf8"), envFile);
		for (const [key, value] of Object.entries(parsed)) {
			const ref = sickratUriToRef(value);
			if (ref) {
				refByKey.set(key, ref);
				preservedEnvFileKeys.delete(key);
			} else {
				refByKey.delete(key);
				env[key] = value;
				preservedEnvFileKeys.add(key);
			}
		}
	}
	for (const { key, value } of directEnv) {
		refByKey.set(key, value);
		preservedEnvFileKeys.delete(key);
	}
	if (refByKey.size === 0) throw new Error("No Sickrat secret references found. Use --env KEY=ref or sickrat:// refs in --env-file.");

	const refs = uniqueRefs([...refByKey.values()]);
	const grant = await requestGrant({
		refs,
		message,
		accessDurationSeconds,
		approvalWaitSeconds,
		command: `sickrat run -- ${formatCommand(commandArgs)}`,
	});
	for (const [key, ref] of refByKey) {
		const value = grant.secrets[ref];
		if (value === undefined) throw new Error(`Approved grant did not include ${ref}.`);
		env[key] = value;
	}

	console.error(`Starting child process with ${refByKey.size} Sickrat env values and ${preservedEnvFileKeys.size} preserved env-file values.`);
	const code = await runChild(commandArgs[0], commandArgs.slice(1), env);
	process.exit(code);
}

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];
	try {
		if (!command || command === "--help" || command === "-h") usage(0);
		if (command === "--version" || command === "-v" || command === "version") {
			console.log(cliVersion);
			return;
		}
		if (hasHelpFlag(args)) {
			if (command === "login") commandHelp("login");
			if (command === "vault" && args[1] === "create") commandHelp("vault create");
			if (command === "vault" && args[1] === "status") commandHelp("vault status");
			if (command === "vault" && args[1] === "update") commandHelp("vault update");
			if (command === "self" && args[1] === "update") commandHelp("self update");
			if (command === "update") commandHelp("update");
			if (command === "pair") commandHelp("pair");
			if (command === "run") commandHelp("run");
			if (command === "reveal" || command === "request") commandHelp("reveal");
			unknownCommand(command);
		}
		if (command === "login") return await cloudflareLogin(args);
		if (command === "provision") return await createVault(args);
		if (command === "vault" && args[1] === "create") return await createVault(args.slice(1));
		if (command === "vault" && args[1] === "status") return await vaultStatus(args);
		if (command === "vault" && args[1] === "update") return await vaultUpdate(args);
		if (command === "self" && args[1] === "update") return await selfUpdate(args);
		if (command === "update") return await updateAll(args);
		if (command === "pair") return await pair(args);
		if (command === "run") return await runWithSecrets(args);
		if (command === "reveal") return await revealSecret(args);
		if (command === "request") {
			console.error("sickrat request is deprecated. Use sickrat reveal for explicit stdout reveal, or sickrat run for env injection.");
			return await revealSecret(["reveal", ...args.slice(1)]);
		}
		unknownCommand(command);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

void main();
