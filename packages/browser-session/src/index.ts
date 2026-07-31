import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";

export const MAX_BROWSER_SESSION_FRAME_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BROWSER_SESSION_IO_TIMEOUT_MS = 2 * 60 * 1000;

export type BrowserCookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Strict" | "Lax" | "None";
	partitionKey?: string;
};

export type StoredValue = {
	name: string;
	value: string;
};

export type OriginStorage = {
	origin: string;
	localStorage?: StoredValue[];
	sessionStorage?: StoredValue[];
	indexedDB?: unknown;
};

export type BrowserSessionBundle = {
	cookies?: BrowserCookie[];
	origins?: OriginStorage[];
};

export type BrowserSessionAccess = "create" | "restore" | "restore_and_update" | "replace";

export type BrowserSessionInput = {
	resourceRef: string;
	access: BrowserSessionAccess;
	bundle?: BrowserSessionBundle;
};

export type BrowserSessionAbortReason =
	| "unchanged"
	| "reauth_required"
	| "user_cancelled"
	| "operation_failed";

export type BrowserSessionResult =
	| { action: "commit"; bundle: BrowserSessionBundle }
	| { action: "abort"; safeReasonCode: BrowserSessionAbortReason };

const inputFdEnvironmentName = "SICKRAT_BROWSER_SESSION_INPUT_FD";
const outputFdEnvironmentName = "SICKRAT_BROWSER_SESSION_OUTPUT_FD";
const allowedBundleKeys = new Set(["cookies", "origins"]);
const allowedCookieKeys = new Set(["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite", "partitionKey"]);
const allowedOriginKeys = new Set(["origin", "localStorage", "sessionStorage", "indexedDB"]);
const allowedStoredValueKeys = new Set(["name", "value"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>) {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isStoredValue(value: unknown): value is StoredValue {
	if (!isRecord(value) || !hasOnlyKeys(value, allowedStoredValueKeys)) return false;
	return isNonEmptyString(value.name, 16 * 1024) && typeof value.value === "string" && value.value.length <= 4 * 1024 * 1024;
}

function isJsonSafe(value: unknown) {
	const seen = new Set<object>();
	let nodes = 0;
	const visit = (candidate: unknown, depth: number): boolean => {
		nodes += 1;
		if (nodes > 250_000 || depth > 64) return false;
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return true;
		if (typeof candidate === "number") return Number.isFinite(candidate);
		if (typeof candidate !== "object") return false;
		if (seen.has(candidate)) return false;
		seen.add(candidate);
		if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1));
		if (!isRecord(candidate)) return false;
		return Object.entries(candidate).every(([key, item]) => key.length <= 16 * 1024 && visit(item, depth + 1));
	};
	return visit(value, 0);
}

export function isBrowserSessionBundle(value: unknown): value is BrowserSessionBundle {
	if (!isRecord(value) || !hasOnlyKeys(value, allowedBundleKeys)) return false;
	if (value.cookies !== undefined && !Array.isArray(value.cookies)) return false;
	if (value.origins !== undefined && !Array.isArray(value.origins)) return false;
	const cookies = value.cookies ?? [];
	const origins = value.origins ?? [];
	if (cookies.length === 0 && origins.length === 0) return false;
	if (cookies.length > 20_000 || origins.length > 2_000) return false;

	for (const cookie of cookies) {
		if (!isRecord(cookie) || !hasOnlyKeys(cookie, allowedCookieKeys)) return false;
		if (
			!isNonEmptyString(cookie.name, 16 * 1024) ||
			typeof cookie.value !== "string" ||
			cookie.value.length > 4 * 1024 * 1024 ||
			!isNonEmptyString(cookie.domain, 8 * 1024) ||
			!isNonEmptyString(cookie.path, 8 * 1024) ||
			typeof cookie.expires !== "number" ||
			!Number.isFinite(cookie.expires) ||
			typeof cookie.httpOnly !== "boolean" ||
			typeof cookie.secure !== "boolean" ||
			!["Strict", "Lax", "None"].includes(String(cookie.sameSite)) ||
			(cookie.partitionKey !== undefined && !isNonEmptyString(cookie.partitionKey, 8 * 1024))
		) {
			return false;
		}
	}

	for (const item of origins) {
		if (!isRecord(item) || !hasOnlyKeys(item, allowedOriginKeys)) return false;
		if (!isNonEmptyString(item.origin, 8 * 1024)) return false;
		try {
			if (new URL(item.origin).origin !== item.origin) return false;
		} catch {
			return false;
		}
		const localStorage = item.localStorage;
		const sessionStorage = item.sessionStorage;
		if (localStorage !== undefined && (!Array.isArray(localStorage) || localStorage.length > 100_000 || !localStorage.every(isStoredValue))) return false;
		if (sessionStorage !== undefined && (!Array.isArray(sessionStorage) || sessionStorage.length > 100_000 || !sessionStorage.every(isStoredValue))) return false;
		if (item.indexedDB !== undefined && !isJsonSafe(item.indexedDB)) return false;
		if (
			(Array.isArray(localStorage) ? localStorage.length : 0) === 0 &&
			(Array.isArray(sessionStorage) ? sessionStorage.length : 0) === 0 &&
			item.indexedDB === undefined
		) {
			return false;
		}
	}

	return isJsonSafe(value);
}

export function assertBrowserSessionBundle(value: unknown): asserts value is BrowserSessionBundle {
	if (!isBrowserSessionBundle(value)) {
		throw new Error("Invalid browser-session bundle structure.");
	}
	const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
	if (bytes > MAX_BROWSER_SESSION_FRAME_BYTES) {
		throw new Error("Browser-session bundle exceeds the size limit.");
	}
}

export function isBrowserSessionResult(value: unknown): value is BrowserSessionResult {
	if (!isRecord(value)) return false;
	if (value.action === "commit") {
		return Object.keys(value).every((key) => key === "action" || key === "bundle") && isBrowserSessionBundle(value.bundle);
	}
	return (
		value.action === "abort" &&
		Object.keys(value).every((key) => key === "action" || key === "safeReasonCode") &&
		["unchanged", "reauth_required", "user_cancelled", "operation_failed"].includes(String(value.safeReasonCode))
	);
}

export function encodeLengthPrefixedJson(value: unknown, maxBytes = MAX_BROWSER_SESSION_FRAME_BYTES) {
	const payload = Buffer.from(JSON.stringify(value), "utf8");
	if (payload.length > maxBytes) throw new Error("Browser-session frame exceeds the size limit.");
	const frame = Buffer.allocUnsafe(payload.length + 4);
	frame.writeUInt32BE(payload.length, 0);
	payload.copy(frame, 4);
	return frame;
}

export function decodeLengthPrefixedJson(frame: Uint8Array, maxBytes = MAX_BROWSER_SESSION_FRAME_BYTES): unknown {
	if (frame.byteLength < 4) throw new Error("Truncated browser-session frame.");
	const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
	const payloadLength = buffer.readUInt32BE(0);
	if (payloadLength > maxBytes) throw new Error("Browser-session frame exceeds the size limit.");
	if (buffer.length !== payloadLength + 4) throw new Error("Invalid browser-session frame length.");
	try {
		return JSON.parse(buffer.subarray(4).toString("utf8"));
	} catch {
		throw new Error("Malformed browser-session JSON frame.");
	}
}

function deadlineSignal(timeoutMs: number, signal?: AbortSignal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Browser-session channel timed out.")), timeoutMs);
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

function channelError(signal: AbortSignal) {
	return signal.reason instanceof Error ? signal.reason : new Error("Browser-session channel was aborted.");
}

async function readExactly(stream: Readable, length: number, signal: AbortSignal) {
	const chunks: Buffer[] = [];
	let received = 0;
	for await (const chunkValue of stream) {
		if (signal.aborted) throw channelError(signal);
		const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
		if (received + chunk.length > length) throw new Error("Browser-session channel contained trailing bytes.");
		chunks.push(chunk);
		received += chunk.length;
	}
	if (signal.aborted) throw channelError(signal);
	if (received !== length) throw new Error("Truncated browser-session frame.");
	return Buffer.concat(chunks, length);
}

export async function readLengthPrefixedJson(
	stream: Readable,
	options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
) {
	const maxBytes = options.maxBytes ?? MAX_BROWSER_SESSION_FRAME_BYTES;
	const deadline = deadlineSignal(options.timeoutMs ?? DEFAULT_BROWSER_SESSION_IO_TIMEOUT_MS, options.signal);
	try {
		const header = await new Promise<Buffer>((resolve, reject) => {
			let received = Buffer.alloc(0);
			const cleanup = () => {
				stream.off("data", onData);
				stream.off("end", onEnd);
				stream.off("error", onError);
				deadline.signal.removeEventListener("abort", onAbort);
			};
			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onData = (chunkValue: Buffer | string) => {
				const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
				received = Buffer.concat([received, chunk]);
				if (received.length < 4) return;
				stream.pause();
				if (received.length > 4) stream.unshift(received.subarray(4));
				cleanup();
				resolve(received.subarray(0, 4));
			};
			const onEnd = () => fail(new Error("Truncated browser-session frame."));
			const onError = (error: Error) => fail(error);
			const onAbort = () => fail(channelError(deadline.signal));
			stream.on("data", onData);
			stream.once("end", onEnd);
			stream.once("error", onError);
			deadline.signal.addEventListener("abort", onAbort, { once: true });
			stream.resume();
		});
		const payloadLength = header.readUInt32BE(0);
		if (payloadLength > maxBytes) throw new Error("Browser-session frame exceeds the size limit.");
		const payload = await readExactly(stream, payloadLength, deadline.signal);
		try {
			return JSON.parse(payload.toString("utf8")) as unknown;
		} catch {
			throw new Error("Malformed browser-session JSON frame.");
		}
	} finally {
		deadline.dispose();
	}
}

export async function writeLengthPrefixedJson(
	stream: Writable,
	value: unknown,
	options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
) {
	const frame = encodeLengthPrefixedJson(value, options.maxBytes);
	const deadline = deadlineSignal(options.timeoutMs ?? DEFAULT_BROWSER_SESSION_IO_TIMEOUT_MS, options.signal);
	try {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				stream.destroy(channelError(deadline.signal));
				reject(channelError(deadline.signal));
			};
			deadline.signal.addEventListener("abort", onAbort, { once: true });
			stream.once("error", reject);
			stream.end(frame, resolve);
		});
	} finally {
		frame.fill(0);
		deadline.dispose();
	}
}

function requiredDescriptor(name: string) {
	const raw = process.env[name] ?? "";
	if (!/^[0-9]+$/.test(raw)) throw new Error(`Missing or invalid ${name}.`);
	const descriptor = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1024) {
		throw new Error(`Missing or invalid ${name}.`);
	}
	return descriptor;
}

export function openGrantedBrowserSession(options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
	const input = createReadStream("", { fd: requiredDescriptor(inputFdEnvironmentName), autoClose: true });
	const output = createWriteStream("", { fd: requiredDescriptor(outputFdEnvironmentName), autoClose: true });
	let read = false;
	let finished = false;

	return {
		async read(): Promise<BrowserSessionInput> {
			if (read) throw new Error("The browser-session transaction can be read only once.");
			read = true;
			const value = await readLengthPrefixedJson(input, options);
			if (!isRecord(value) || !isNonEmptyString(value.resourceRef, 512) || !["create", "restore", "restore_and_update", "replace"].includes(String(value.access))) {
				throw new Error("Invalid browser-session transaction input.");
			}
			if (value.bundle !== undefined) assertBrowserSessionBundle(value.bundle);
			if ((value.access === "restore" || value.access === "restore_and_update") && value.bundle === undefined) {
				throw new Error("The browser-session transaction did not include a bundle.");
			}
			if ((value.access === "create" || value.access === "replace") && value.bundle !== undefined) {
				throw new Error("This browser-session producer transaction must not include a bundle.");
			}
			return value as BrowserSessionInput;
		},
		async commit(bundle: BrowserSessionBundle) {
			if (finished) throw new Error("The browser-session transaction is already finished.");
			assertBrowserSessionBundle(bundle);
			finished = true;
			await writeLengthPrefixedJson(output, { action: "commit", bundle } satisfies BrowserSessionResult, options);
		},
		async abort(safeReasonCode: BrowserSessionAbortReason) {
			if (finished) throw new Error("The browser-session transaction is already finished.");
			if (!["unchanged", "reauth_required", "user_cancelled", "operation_failed"].includes(safeReasonCode)) {
				throw new Error("Invalid browser-session abort reason.");
			}
			finished = true;
			await writeLengthPrefixedJson(output, { action: "abort", safeReasonCode } satisfies BrowserSessionResult, options);
		},
	};
}
