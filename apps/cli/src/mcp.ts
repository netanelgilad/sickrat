import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ApprovalRequestCreate, GrantPayload } from "@sickrat/protocol";

const trimmed = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value, "Must not have surrounding whitespace");
const segment = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const resource = z.discriminatedUnion("type", [
	z.object({ type: z.literal("secret"), ref: trimmed(512) }).strict(),
	z.object({ type: z.literal("oauth_token"), providerId: segment, connectionName: segment.optional(),
		scopes: z.array(trimmed(256)).min(1).max(20).refine(values => new Set(values).size === values.length, "Duplicate scopes") }).strict(),
]);
export const accessInput = z.object({
	resources: z.array(resource).min(1).max(20),
	message: trimmed(600),
	approvalWaitSeconds: z.number().int().min(60).max(28800).default(120),
}).strict();
export type AccessInput = z.infer<typeof accessInput>;
export type McpBackend = {
	status(): Promise<Record<string, unknown>>;
	providers(): Promise<unknown>;
	connections(): Promise<unknown>;
	request(input: { refs: string[]; resourceRequests: ApprovalRequestCreate["resourceRequests"]; message: string;
		command: string; approvalWaitSeconds: number; allowCache: false; signal: AbortSignal;
		onCreated: (requestId: string, approvalUrl: string) => void }): Promise<GrantPayload>;
};
type Job = { controller: AbortController; expiresAt: number; status: "pending" | "ready" | "failed";
	requestId?: string; approvalUrl?: string; grant?: GrantPayload };

// One process is one paired-device principal. No grant, key, or job is persisted.
export class AccessJobs {
	private jobs = new Map<string, Job>();
	private timer: ReturnType<typeof setInterval>;
	private backend: McpBackend;
	private now: () => number;
	constructor(backend: McpBackend, now = Date.now) {
		this.backend = backend; this.now = now;
		this.timer = setInterval(() => this.sweep(), 1000);
		this.timer.unref();
	}
	private sweep() {
		for (const [id, job] of this.jobs) if (job.expiresAt <= this.now()) this.remove(id);
	}
	private remove(id: string) {
		const job = this.jobs.get(id);
		job?.controller.abort();
		if (job) job.grant = undefined;
		this.jobs.delete(id);
	}
	start(raw: AccessInput) {
		const input = accessInput.parse(raw);
		this.sweep();
		if (this.jobs.size >= 20) throw new Error("Too many outstanding requests; collect or cancel an existing request.");
		const id = randomUUID();
		const job: Job = { controller: new AbortController(), status: "pending", expiresAt: this.now() + input.approvalWaitSeconds * 1000 };
		this.jobs.set(id, job);
		const resourceRequests = input.resources.map((item, index) => item.type === "secret" ? item : { ...item, env: `MCP_TOKEN_${index}` });
		void Promise.resolve().then(() => {
			job.controller.signal.throwIfAborted();
			return this.backend.request({ refs: input.resources.flatMap(item => item.type === "secret" ? [item.ref] : []),
				resourceRequests, message: input.message, command: "sickrat mcp: collect_access (returns plaintext to the MCP client)",
				approvalWaitSeconds: input.approvalWaitSeconds, allowCache: false, signal: job.controller.signal,
				onCreated: (requestId, approvalUrl) => { job.requestId = requestId; job.approvalUrl = approvalUrl; } });
		}).then(grant => {
			if (!this.jobs.has(id) || job.expiresAt <= this.now()) return;
			// Project only requested values; never forward extra material from a grant.
			const secrets: Record<string, string> = Object.create(null);
			const oauthTokens: NonNullable<GrantPayload["oauthTokens"]> = Object.create(null);
			for (const [index, item] of input.resources.entries()) {
				if (item.type === "secret") {
					if (typeof grant.secrets?.[item.ref] !== "string") throw new Error("Missing secret");
					secrets[item.ref] = grant.secrets[item.ref];
				} else {
					const token = grant.oauthTokens?.[`MCP_TOKEN_${index}`];
					if (!token || token.providerId !== item.providerId || (item.connectionName && token.connectionName !== item.connectionName)
						|| item.scopes.some(scope => !token.scopes.includes(scope))) throw new Error("Invalid OAuth grant");
					if (token.expiresAt) {
						const expiry = Date.parse(token.expiresAt);
						if (!Number.isFinite(expiry) || expiry <= this.now()) throw new Error("Expired OAuth grant");
						job.expiresAt = Math.min(job.expiresAt, expiry);
					}
					oauthTokens[`MCP_TOKEN_${index}`] = { providerId: token.providerId, connectionId: token.connectionId, connectionName: token.connectionName, accessToken: token.accessToken, tokenType: token.tokenType, scopes: token.scopes, expiresAt: token.expiresAt };
				}
			}
			job.grant = { secrets, oauthTokens, approvedAt: grant.approvedAt };
			job.status = "ready";
			job.expiresAt = Math.min(job.expiresAt, this.now() + 60_000);
		}).catch(() => {
			if (this.jobs.has(id)) { job.status = "failed"; job.expiresAt = Math.min(job.expiresAt, this.now() + 60_000); }
		});
		return { ticket: id, status: "pending", expiresAt: new Date(job.expiresAt).toISOString() };
	}
	collect(id: string) {
		this.sweep();
		const job = this.jobs.get(id);
		if (!job) return { status: "unavailable", message: "Unknown, expired, cancelled, or already collected ticket." };
		if (job.status === "pending") return { status: "pending", requestId: job.requestId, approvalUrl: job.approvalUrl };
		const result = job.status === "ready" ? { status: "approved", grant: job.grant } : { status: "failed", message: "Access was denied, expired, or could not be retrieved. Check the vault before requesting again." };
		this.remove(id);
		return result;
	}
	cancel(id: string) { this.remove(id); return { status: "cancelled", message: "Local collection stopped. A pending phone approval expires normally." }; }
	close() { clearInterval(this.timer); for (const id of this.jobs.keys()) this.remove(id); }
}

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
export function createVaultMcpServer(backend: McpBackend, jobs: AccessJobs, version: string) {
	const server = new McpServer({ name: "sickrat-vault", version }, { instructions: "Request access with a specific reason, then poll collect_access. Phone approval is mandatory. collect_access returns plaintext secrets/access tokens; keep these out of chat and logs. Never request vault keys or refresh tokens." });
	const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
	server.registerTool("vault_status", { description: "Inspect this MCP host's paired vault and device (no credentials).", inputSchema: {}, annotations: read }, async () => result(await backend.status()));
	server.registerTool("list_oauth_providers", { description: "Inspect configured OAuth providers and supported scopes.", inputSchema: {}, annotations: read }, async () => result(await backend.providers()));
	server.registerTool("list_oauth_connections", { description: "Inspect active OAuth connection metadata, never refresh tokens.", inputSchema: {}, annotations: read }, async () => result(await backend.connections()));
	server.registerTool("request_access", { description: "Request phone approval for secrets or short-lived OAuth tokens. Returns a ticket immediately. Values are returned by collect_access and retained for at most 60 seconds after approval. No cached approvals are reused.", inputSchema: accessInput.shape,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }, async input => result(jobs.start(input)));
	server.registerTool("collect_access", { description: "Poll a ticket (about every 2 seconds). Once approved, returns PLAINTEXT requested values exactly once and consumes the ticket. Do not display these in chat or logs.", inputSchema: { ticket: z.string().uuid() },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async ({ ticket }) => result(jobs.collect(ticket)));
	server.registerTool("cancel_access", { description: "Discard a local ticket and any uncollected values. Does not deny the phone approval; it expires normally.", inputSchema: { ticket: z.string().uuid() },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async ({ ticket }) => result(jobs.cancel(ticket)));
	return server;
}

export function createMcpHttpServer(backend: McpBackend, jobs: AccessJobs, version: string, token: string, allowedHosts: string[]) {
	if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new Error("MCP token must be a random base64url token of at least 32 bytes.");
	const expected = Buffer.from(`Bearer ${token}`);
	return createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allowedHosts.includes(req.headers.host ?? "") || req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
		const supplied = Buffer.from(req.headers.authorization ?? "");
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
			res.setHeader("WWW-Authenticate", 'Bearer realm="sickrat-mcp"'); res.writeHead(401).end(); return;
		}
		if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
		if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.writeHead(405).end(); return; }
		let size = 0;
		const chunks: Buffer[] = [];
		try {
			for await (const chunk of req) {
				size += chunk.length;
				if (size > 64 * 1024) { res.writeHead(413).end(); return; }
				chunks.push(Buffer.from(chunk));
			}
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
			catch { res.writeHead(400).end(); return; }
			const server = createVaultMcpServer(backend, jobs, version);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			res.on("close", () => { void server.close(); });
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch { if (!res.headersSent) res.writeHead(500); res.end(); }
	});
}

export async function startMcp(args: string[], backend: McpBackend, version: string) {
	const options: Record<string, string> = {};
	for (let i = 0; i < args.length; i += 2) {
		if (!["--transport", "--port", "--token-file", "--public-url"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Invalid MCP options. Run sickrat mcp --help.");
		options[args[i]] = args[i + 1];
	}
	const transport = options["--transport"] ?? "stdio";
	if (transport !== "stdio" && transport !== "http") throw new Error("MCP transport must be stdio or http.");
	if (transport === "stdio" && Object.keys(options).some(key => key !== "--transport")) throw new Error("HTTP options require --transport http.");
	await backend.status(); // Fail before opening a listener when pairing is missing.
	if (transport === "stdio") {
		const jobs = new AccessJobs(backend);
		const server = createVaultMcpServer(backend, jobs, version);
		server.server.onclose = () => jobs.close();
		await server.connect(new StdioServerTransport());
		return;
	}
	const port = Number(options["--port"] ?? "8789");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP port.");
	if (!options["--token-file"]) throw new Error("HTTP requires --token-file with a random base64url bearer token.");
	const token = (await readFile(options["--token-file"], "utf8")).trim();
	const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
	if (options["--public-url"]) {
		const url = new URL(options["--public-url"]);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("Public URL must be an HTTPS URL ending in /mcp.");
		hosts.push(url.host);
	}
	const jobs = new AccessJobs(backend);
	const server = createMcpHttpServer(backend, jobs, version, token, hosts);
	server.on("close", () => jobs.close());
	server.on("error", () => jobs.close());
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
	console.error(`Sickrat MCP listening on http://127.0.0.1:${port}/mcp`);
}
