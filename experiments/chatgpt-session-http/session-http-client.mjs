const forbiddenReplayHeaders = new Set([
	"connection",
	"content-length",
	"cookie",
	"host",
	"proxy-authorization",
	"transfer-encoding",
]);

export class BrowserSessionHttpClient {
	#bundle;
	#fetch;
	#now;

	constructor(bundle, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
		validateBundle(bundle);
		if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
		this.#bundle = structuredClone(bundle);
		this.#fetch = fetchImpl;
		this.#now = now;
	}

	async get(url, { headers = {} } = {}) {
		const target = new URL(url);
		assertAllowedOrigin(target, this.#bundle.allowedOrigins);
		const cookieSelection = selectCookies(this.#bundle.storageState.cookies, target, this.#now());
		const requestHeaders = new Headers(headers);
		requestHeaders.set("accept", requestHeaders.get("accept") || "application/json");
		if (cookieSelection.header) requestHeaders.set("cookie", cookieSelection.header);

		const response = await this.#fetch(target, {
			method: "GET",
			headers: requestHeaders,
			redirect: "manual",
		});
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			const redirectTarget = new URL(location, target);
			assertAllowedOrigin(redirectTarget, this.#bundle.allowedOrigins);
			throw new Error("Browser-session HTTP request requires explicit same-origin redirect handling.");
		}

		return {
			response,
			requestMetadata: {
				cookieCount: cookieSelection.includedCount,
				excludedPartitionedCookieCount: cookieSelection.excludedPartitionedCount,
				setCookieCount: getSetCookieHeaders(response.headers).length,
			},
		};
	}
}

export function sanitizeObservedRequestHeaders(input) {
	const output = {};
	for (const [rawName, rawValue] of Object.entries(input ?? {})) {
		const name = rawName.toLowerCase();
		if (
			name.startsWith(":")
			|| forbiddenReplayHeaders.has(name)
			|| typeof rawValue !== "string"
			|| rawValue.includes("\r")
			|| rawValue.includes("\n")
		) {
			continue;
		}
		output[name] = rawValue;
	}
	return output;
}

export function selectCookies(cookies, target, nowMs = Date.now()) {
	const selected = [];
	let excludedPartitionedCount = 0;

	for (const cookie of cookies) {
		if (!cookieMatchesTarget(cookie, target, nowMs)) continue;
		if (cookie.partitionKey !== undefined || cookie.partitioned === true) {
			excludedPartitionedCount += 1;
			continue;
		}
		selected.push(cookie);
	}

	selected.sort((left, right) => right.path.length - left.path.length);
	return {
		header: selected.map(cookie => `${cookie.name}=${cookie.value}`).join("; "),
		includedCount: selected.length,
		excludedPartitionedCount,
	};
}

export function describeJsonShape(value, depth = 0) {
	if (value === null) return { type: "null" };
	if (Array.isArray(value)) {
		return {
			type: "array",
			observedLength: value.length,
			...(depth < 2 && value.length > 0 ? { items: describeJsonShape(value[0], depth + 1) } : {}),
		};
	}
	if (typeof value !== "object") return { type: typeof value };
	const keys = Object.keys(value).sort();
	return {
		type: "object",
		keys,
		...(depth < 2
			? {
					properties: Object.fromEntries(
						keys.slice(0, 80).map(key => [key, describeJsonShape(value[key], depth + 1)]),
					),
				}
			: {}),
	};
}

export function findConversationCollection(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	for (const [field, candidate] of Object.entries(value)) {
		if (!["items", "conversations"].includes(field)) continue;
		if (!Array.isArray(candidate) || candidate.length === 0) continue;
		const item = candidate.find(entry => entry && typeof entry === "object" && !Array.isArray(entry));
		if (!item) continue;
		const keys = new Set(Object.keys(item));
		const idField = ["id", "conversation_id", "conversationId"].find(key => keys.has(key));
		const titleField = ["title", "name"].find(key => keys.has(key));
		const temporalFields = ["create_time", "update_time", "created_at", "updated_at"]
			.filter(key => keys.has(key));
		if (!idField || !titleField || temporalFields.length === 0) continue;
		const id = item[idField];
		if (typeof id !== "string" || id.length === 0) continue;
		return {
			arrayField: field,
			idField,
			titleField,
			temporalFields,
			itemKeys: [...keys].sort(),
		};
	}
	return null;
}

function cookieMatchesTarget(cookie, target, nowMs) {
	if (
		!cookie
		|| typeof cookie.name !== "string"
		|| typeof cookie.value !== "string"
		|| typeof cookie.domain !== "string"
		|| typeof cookie.path !== "string"
	) {
		return false;
	}
	if (cookie.secure === true && target.protocol !== "https:") return false;
	if (Number.isFinite(cookie.expires) && cookie.expires > 0 && cookie.expires * 1000 <= nowMs) return false;

	const hostname = target.hostname.toLowerCase();
	const rawDomain = cookie.domain.toLowerCase();
	const domain = rawDomain.replace(/^\./, "");
	const domainMatches = rawDomain.startsWith(".")
		? hostname === domain || hostname.endsWith(`.${domain}`)
		: hostname === domain;
	if (!domainMatches) return false;

	const requestPath = target.pathname || "/";
	if (!requestPath.startsWith(cookie.path)) return false;
	if (
		requestPath.length > cookie.path.length
		&& !cookie.path.endsWith("/")
		&& requestPath[cookie.path.length] !== "/"
	) {
		return false;
	}
	return true;
}

function validateBundle(bundle) {
	if (!bundle || typeof bundle !== "object" || bundle.formatVersion !== 1) {
		throw new TypeError("A version 1 browser-session bundle is required.");
	}
	if (!Array.isArray(bundle.allowedOrigins) || bundle.allowedOrigins.length === 0) {
		throw new TypeError("The browser-session origin allowlist is required.");
	}
	if (!bundle.storageState || !Array.isArray(bundle.storageState.cookies)) {
		throw new TypeError("The browser-session cookie state is required.");
	}
	for (const origin of bundle.allowedOrigins) {
		const url = new URL(origin);
		if (url.origin !== origin || url.protocol !== "https:") {
			throw new TypeError("Browser-session origins must be exact HTTPS origins.");
		}
	}
}

function assertAllowedOrigin(target, allowedOrigins) {
	if (!allowedOrigins.includes(target.origin)) {
		throw new Error("Browser-session HTTP request is outside the immutable origin allowlist.");
	}
}

function getSetCookieHeaders(headers) {
	if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
	const combined = headers.get("set-cookie");
	return combined ? [combined] : [];
}
