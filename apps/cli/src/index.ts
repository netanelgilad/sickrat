#!/usr/bin/env bun
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

type CloudflareWorkerScriptSummary = {
	id: string;
	migration_tag?: string;
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const configPath = join(homedir(), ".sickrat", "config.json");
const sourcePath = fileURLToPath(import.meta.url);
const grantWrapInfo = textEncoder.encode("sickrat:cli-grant:v1");
const grantWrapSalt = textEncoder.encode("sickrat:grant-ecdh:v1");
const defaultCloudflareClientId = "768469d277d474beaedd85115b63a81d";
const cliVersion = "0.1.10";
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

	return await downloadReleaseWebArtifact();
}

async function downloadReleaseWebArtifact(): Promise<WebArtifact> {
	const cacheRoot = join(homedir(), ".sickrat", "artifacts", `web-v${cliVersion}`);
	const workerDir = join(cacheRoot, "sickrat");
	const clientDir = join(cacheRoot, "client");
	if (existsSync(join(workerDir, "index.js")) && existsSync(join(clientDir, "index.html"))) {
		return { workerDir, clientDir };
	}

	await rm(cacheRoot, { recursive: true, force: true });
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
	const tempDir = await mkdtemp(join(tmpdir(), "sickrat-web-"));
	const archivePath = join(tempDir, "sickrat-web-dist.tar.gz");
	const url = `${releaseBaseUrl}/v${cliVersion}/sickrat-web-dist.tar.gz`;

	try {
		console.error(`Downloading Sickrat web artifact v${cliVersion}...`);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Release artifact download failed with HTTP ${response.status}.`);
		}
		await writeFile(archivePath, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
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
  sickrat pair <worker-url> [--label <name>]
  sickrat run [--env KEY=ref] [--env-file <path>] [--message <why>] -- <command...>
  sickrat reveal <ref> [--message <why>]

Examples:
  sickrat login
  sickrat vault create personal
  sickrat pair https://sickrat-personal.<your-subdomain>.workers.dev
  sickrat run --env SERVICE_TOKEN=service/api-token -- npm test
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
		pair: `sickrat pair

Usage:
  sickrat pair <worker-url> [--label <name>]

Pairs this machine with an existing Sickrat vault after phone approval.
`,
		run: `sickrat run

Usage:
  sickrat run [--env KEY=ref] [--env-file <path>] [--message <why>] -- <command...>

Requests phone approval for referenced secrets, injects approved values into the child process environment, and never prints secret values.

Examples:
  sickrat run --env SERVICE_USERNAME=service/username --env SERVICE_PASSWORD=service/password -- npm run sync:service
  sickrat run --env-file .env.sickrat -- npm run sync:service
`,
		reveal: `sickrat reveal

Usage:
  sickrat reveal <ref> [--message <why>]

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
			console.error(`Cloudflare login URL: ${authUrl.toString()}`);
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
}) {
	const artifact = await resolveWebArtifact();
	console.error("Building vault PWA and Worker bundle...");
	if (artifact.build) await artifact.build();

	console.error("Generating vault-specific VAPID keys...");
	const vapid = await generateVapidKeys();
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
			vapidPublicKey: vapid.publicKey,
			vapidPrivateKey: vapid.privateKey,
			assetsJwt,
			workerDir: artifact.workerDir,
		});
		await enableWorkerSubdomain(input.accountId, input.accessToken, input.scriptName);
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

	await deployVaultWorker({
		accessToken: cloudflare.accessToken,
		accountId: account.id,
		scriptName: vault.scriptName,
		d1Id: d1.database.uuid,
		vaultName: vault.name,
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
	};
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

async function requestGrant(input: { refs: string[]; message?: string; command: string }) {
	validateRequestMessage(input.message);
	const refs = uniqueRefs(input.refs);
	const config = await readConfig();
	if (!config.workerUrl || !config.deviceId) {
		throw new Error("No paired device config found. Run sickrat pair <worker-url> first.");
	}
	const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const ephemeralPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const unsigned = {
		deviceId: config.deviceId,
		command: input.command,
		message: input.message,
		secretRefs: refs,
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
	console.error(`Requested refs: ${refs.join(", ")}`);

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
			for (const ref of refs) {
				if (grant.secrets[ref] === undefined) throw new Error(`Approved grant did not include ${ref}.`);
			}
			console.error("Approved. Grant received.");
			return grant;
		}
	}

	throw new Error("Timed out waiting for approval.");
}

async function revealSecret(args: string[]) {
	const ref = args.find((arg, index) => index > 0 && !arg.startsWith("-") && args[index - 1] !== "--message" && args[index - 1] !== "-m");
	if (!ref?.trim() || ref.trim() !== ref) commandHelp("reveal");
	const message = getAnyArgValue(args, ["--message", "-m"]) ?? undefined;
	const grant = await requestGrant({
		refs: [ref],
		message,
		command: `sickrat reveal ${ref}`,
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
	validateRequestMessage(message);

	for (let index = 0; index < beforeCommand.length; index += 1) {
		const arg = beforeCommand[index];
		if (arg === "--env" || arg === "--env-file" || arg === "--message" || arg === "-m") {
			index += 1;
			continue;
		}
		throw new Error(`Unknown sickrat run option: ${arg}`);
	}

	const env: NodeJS.ProcessEnv = { ...process.env };
	const refByKey = new Map<string, string>();
	for (const envFile of envFiles) {
		const parsed = parseDotenv(await readFile(envFile, "utf8"), envFile);
		for (const [key, value] of Object.entries(parsed)) {
			const ref = sickratUriToRef(value);
			if (ref) {
				refByKey.set(key, ref);
			} else {
				refByKey.delete(key);
				env[key] = value;
			}
		}
	}
	for (const { key, value } of directEnv) {
		refByKey.set(key, value);
	}
	if (refByKey.size === 0) throw new Error("No Sickrat secret references found. Use --env KEY=ref or sickrat:// refs in --env-file.");

	const refs = uniqueRefs([...refByKey.values()]);
	const grant = await requestGrant({
		refs,
		message,
		command: `sickrat run -- ${formatCommand(commandArgs)}`,
	});
	for (const [key, ref] of refByKey) {
		const value = grant.secrets[ref];
		if (value === undefined) throw new Error(`Approved grant did not include ${ref}.`);
		env[key] = value;
	}

	console.error(`Starting child process with ${refByKey.size} Sickrat env values.`);
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
			if (command === "pair") commandHelp("pair");
			if (command === "run") commandHelp("run");
			if (command === "reveal" || command === "request") commandHelp("reveal");
			unknownCommand(command);
		}
		if (command === "login") return await cloudflareLogin(args);
		if (command === "provision") return await createVault(args);
		if (command === "vault" && args[1] === "create") return await createVault(args.slice(1));
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
