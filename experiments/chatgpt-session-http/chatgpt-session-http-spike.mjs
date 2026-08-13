#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import {
	loadEncryptedBundle,
	saveEncryptedBundle,
} from "./encrypted-bundle-store.mjs";
import {
	BrowserSessionHttpClient,
	describeJsonShape,
	findConversationCollection,
	sanitizeObservedRequestHeaders,
} from "./session-http-client.mjs";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_CONVERSATION_COLLECTION_PATH = "/backend-api/conversations";
const AUTH_TIMEOUT_MS = numberEnv("CHATGPT_SPIKE_AUTH_TIMEOUT_MS", 10 * 60_000);
const REQUEST_TIMEOUT_MS = numberEnv("CHATGPT_SPIKE_REQUEST_TIMEOUT_MS", 60_000);
const MAX_JSON_BYTES = numberEnv("CHATGPT_SPIKE_MAX_JSON_BYTES", 10_000_000);
const USE_REMOTE_BROWSER = process.env.CHATGPT_REMOTE_BROWSER !== "0";
const SESSION_ENCRYPTION_SECRET = process.env.CHATGPT_SESSION_ENCRYPTION_KEY;
const SESSION_CHECKPOINT_PATH = process.env.CHATGPT_SESSION_BUNDLE_PATH
	|| fileURLToPath(new URL("./artifacts/chatgpt-primary.bundle.enc", import.meta.url));
const RESET_SESSION_CHECKPOINT = process.env.CHATGPT_SESSION_RESET === "1";
const REMOTE_BROWSER_ORIGINS = [
	CHATGPT_ORIGIN,
	"https://auth.openai.com",
	"https://accounts.google.com",
	"https://appleid.apple.com",
	"https://login.microsoftonline.com",
];
const REMOTE_BROWSER_CONTROL_URL = new URL(
	"../../../israeli-finance-control/remote-browser-control/src/index.mjs",
	import.meta.url,
);
const REMOTE_AUTHENTICATION_HANDOFF_URL = new URL(
	"../../../israeli-finance-control/provider-probes/remote-authentication-handoff.mjs",
	import.meta.url,
);
const PATCHRIGHT_URL = new URL(
	"../../../israeli-finance-control/expense-importer/node_modules/patchright/index.js",
	import.meta.url,
);
const SESSION_IDENTITY = {
	providerId: "chatgpt",
	accountLabel: "primary",
	allowedOrigins: [CHATGPT_ORIGIN],
};

const patchright = await import(PATCHRIGHT_URL.href);
const { chromium } = patchright.default ?? patchright;
const activeContexts = new Set();
const browser = await chromium.launch({
	channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
	// Authentication remains a user-controlled interaction in an ordinary
	// headful Chrome window exposed through the tailnet viewer.
	headless: false,
	timeout: REQUEST_TIMEOUT_MS,
});
const cleanup = createCleanup(browser, activeContexts);
const disposeSignals = installSignalCleanup(cleanup);

try {
	let bundle = SESSION_ENCRYPTION_SECRET && !RESET_SESSION_CHECKPOINT
		? await loadEncryptedBundle(SESSION_CHECKPOINT_PATH, SESSION_ENCRYPTION_SECRET)
		: null;
	const loadedFromEncryptedCheckpoint = bundle !== null;

	if (bundle) {
		console.error("[chatgpt-spike] Loaded the encrypted ChatGPT session checkpoint; interactive sign-in is being skipped.");
	} else {
		const authenticationContext = await createContext();
		const authenticationPage = await authenticationContext.newPage();
		const authenticationObserver = observeJsonEndpoints(authenticationPage);
		await authenticationPage.goto(CHATGPT_ORIGIN, { waitUntil: "domcontentloaded" });

		const browserCollectionPromise = authenticationObserver.waitForConversationCollection(AUTH_TIMEOUT_MS);
		if (USE_REMOTE_BROWSER) {
			await completeAuthenticationThroughRemoteBrowser(authenticationPage, browserCollectionPromise);
		} else {
			console.error("[chatgpt-spike] Sign in to ChatGPT in the fresh local browser window. No credentials or conversation contents will be logged.");
		}
		await browserCollectionPromise;
		bundle = await captureBundle(authenticationContext, authenticationPage);
		if (SESSION_ENCRYPTION_SECRET) {
			await saveEncryptedBundle(SESSION_CHECKPOINT_PATH, bundle, SESSION_ENCRYPTION_SECRET);
			console.error("[chatgpt-spike] Saved an encrypted session checkpoint; no plaintext session file was written.");
		}
		await authenticationObserver.settle();
		await closeContext(authenticationContext);
	}

	const restoredContext = await createContext(bundle);
	const restoredPage = await createSessionRestoredPage(restoredContext, bundle);
	const restoredObserver = observeJsonEndpoints(restoredPage);
	await restoredPage.goto(CHATGPT_ORIGIN, { waitUntil: "domcontentloaded" });
	const restoredCollection = await restoredObserver.waitForConversationCollection(REQUEST_TIMEOUT_MS);
	bundle = await captureBundle(restoredContext, restoredPage);
	bundle.httpProfiles = {
		conversationList: {
			formatVersion: 1,
			method: "GET",
			url: restoredCollection.url,
			headers: sanitizeObservedRequestHeaders(restoredCollection.requestHeaders),
			capturedAt: new Date().toISOString(),
		},
	};
	if (SESSION_ENCRYPTION_SECRET) {
		await saveEncryptedBundle(SESSION_CHECKPOINT_PATH, bundle, SESSION_ENCRYPTION_SECRET);
	}
	const bundleSummary = summarizeBundle(bundle);
	await restoredObserver.settle();
	await closeContext(restoredContext);

	const compatibilityHeaders = selectCompatibilityHeaders(bundle.httpProfiles.conversationList.headers);
	const cookieOnlyAttempt = await attemptDirectRequest(bundle, restoredCollection.url, compatibilityHeaders);
	let observedHeaderAttempt = null;
	if (!cookieOnlyAttempt.collectionDetected) {
		observedHeaderAttempt = await attemptDirectRequest(
			bundle,
			bundle.httpProfiles.conversationList.url,
			bundle.httpProfiles.conversationList.headers,
		);
	}

	const successfulDirectAttempt = cookieOnlyAttempt.collectionDetected
		? "cookie_only"
		: observedHeaderAttempt?.collectionDetected
			? "observed_headers"
			: null;

	console.log(JSON.stringify({
		success: true,
		provider: "chatgpt",
		experimentalUnsupportedWebApi: true,
		sessionCheckpoint: {
			mode: SESSION_ENCRYPTION_SECRET ? "sickrat_keyed_local_ciphertext_bridge" : "memory_only",
			loadedFromEncryptedCheckpoint,
			plaintextPersisted: false,
		},
		browserBundle: bundleSummary,
		browserRestore: {
			healthy: true,
			collectionEndpoint: sanitizeEndpoint(restoredCollection.url),
			responseShape: restoredCollection.shape,
		},
		directHttp: {
			supported: successfulDirectAttempt !== null,
			successfulMode: successfulDirectAttempt,
			cookieOnly: cookieOnlyAttempt,
			...(observedHeaderAttempt ? { observedHeaders: observedHeaderAttempt } : {}),
		},
		privacy: {
			conversationBodiesPersisted: false,
			conversationIdentifiersPersisted: false,
			plaintextSessionStatePersisted: false,
			encryptedSessionStatePersisted: Boolean(SESSION_ENCRYPTION_SECRET),
			plaintextRequestHeadersPersisted: false,
			encryptedRequestProfilePersisted: Boolean(SESSION_ENCRYPTION_SECRET),
		},
	}, null, 2));
} finally {
	disposeSignals();
	await cleanup();
}

async function completeAuthenticationThroughRemoteBrowser(page, browserCollectionPromise) {
	const [
		{
			createRemoteBrowserController,
			createTailscaleServePublisher,
		},
		{ runRemoteAuthenticationHandoff },
	] = await Promise.all([
		import(REMOTE_BROWSER_CONTROL_URL.href),
		import(REMOTE_AUTHENTICATION_HANDOFF_URL.href),
	]);
	const publisher = createTailscaleServePublisher({
		socketPath: process.env.TAILSCALE_SOCKET || "/tmp/tailscaled.sock",
		preferredHttpsPorts: [8446, 8447, 8448, 8449, 8450, 8451, 8452, 8453, 8454, 8455],
	});
	const controller = await createRemoteBrowserController({
		page,
		publisher,
		onEvent(event) {
			console.error(`[chatgpt-remote] ${JSON.stringify(event)}`);
		},
	});
	await runRemoteAuthenticationHandoff({
		controller,
		sessionOptions: {
			purpose: "Sign in to ChatGPT for the browser-session portability spike",
			allowedTopLevelOrigins: REMOTE_BROWSER_ORIGINS,
			capabilities: ["view", "click", "type", "scroll"],
			adaptViewport: true,
			allowUserDone: false,
			ttlMs: Math.min(AUTH_TIMEOUT_MS, 15 * 60_000),
			disconnectGraceMs: Math.min(AUTH_TIMEOUT_MS, 2 * 60_000),
		},
		waitForAuthenticated: () => browserCollectionPromise,
		notify: async ({ url, expiresAt }) => {
			console.log(JSON.stringify({
				type: "remote-browser-ready",
				url,
				expiresAt: expiresAt.toISOString(),
			}));
		},
		completionMessage: "ChatGPT sign-in succeeded. The session portability spike is continuing.",
	});
}

function observeJsonEndpoints(page) {
	const pending = new Set();
	let resolved = false;
	let resolveCollection;
	let rejectCollection;
	const collectionPromise = new Promise((resolve, reject) => {
		resolveCollection = resolve;
		rejectCollection = reject;
	});

	page.on("response", response => {
		const task = inspectResponse(response)
			.then(result => {
				if (!result || resolved) return;
				if (new URL(result.url).pathname !== CHATGPT_CONVERSATION_COLLECTION_PATH) return;
				const collection = findConversationCollection(result.payload);
				if (!collection) return;
				resolved = true;
				resolveCollection({
					url: result.url,
					method: result.method,
					status: result.status,
					shape: describeJsonShape(result.payload),
					requestHeaders: result.requestHeaders,
				});
			})
			.catch(() => {});
		pending.add(task);
		task.finally(() => pending.delete(task));
	});

	return {
		async waitForConversationCollection(timeoutMs) {
			const timeout = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				rejectCollection(new Error("ChatGPT conversation collection was not observed before the authentication timeout."));
			}, timeoutMs);
			timeout.unref?.();
			try {
				return await collectionPromise;
			} finally {
				clearTimeout(timeout);
			}
		},
		async settle() {
			await Promise.allSettled([...pending]);
		},
	};
}

async function inspectResponse(response) {
	const url = new URL(response.url());
	if (url.origin !== CHATGPT_ORIGIN || response.status() !== 200) return null;
	const contentType = response.headers()["content-type"] || "";
	if (!contentType.toLowerCase().includes("application/json")) return null;
	const request = response.request();
	if (request.method() !== "GET") return null;
	const contentLength = Number(response.headers()["content-length"]);
	if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) return null;
	const body = await response.body().catch(() => null);
	if (!body || body.byteLength > MAX_JSON_BYTES) return null;
	let payload;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		return null;
	}
	const requestHeaders = typeof request.allHeaders === "function"
		? await request.allHeaders()
		: request.headers();
	return {
		url: response.url(),
		method: request.method(),
		status: response.status(),
		payload,
		requestHeaders,
	};
}

async function captureBundle(context, page) {
	const rawStorageState = await context.storageState({ indexedDB: true });
	const storageState = {
		cookies: rawStorageState.cookies.filter(cookie => cookieMatchesAllowedOrigin(cookie)),
		origins: rawStorageState.origins.filter(origin => SESSION_IDENTITY.allowedOrigins.includes(origin.origin)),
	};
	const sessionStorageEntries = await page.evaluate(() => Object.fromEntries(
		Array.from({ length: window.sessionStorage.length }, (_, index) => {
			const key = window.sessionStorage.key(index);
			return key === null ? null : [key, window.sessionStorage.getItem(key) ?? ""];
		}).filter(Boolean),
	));
	return {
		formatVersion: 1,
		...SESSION_IDENTITY,
		browserFamily: "chromium",
		storageState,
		...(Object.keys(sessionStorageEntries).length > 0
			? { sessionStorageByOrigin: { [CHATGPT_ORIGIN]: sessionStorageEntries } }
			: {}),
		capturedAt: new Date().toISOString(),
	};
}

async function createContext(bundle) {
	const context = await browser.newContext({
		viewport: null,
		locale: "en-US",
		...(bundle ? { storageState: structuredClone(bundle.storageState) } : {}),
	});
	activeContexts.add(context);
	return context;
}

async function createSessionRestoredPage(context, bundle) {
	const page = await context.newPage();
	const entries = bundle.sessionStorageByOrigin?.[CHATGPT_ORIGIN];
	if (!entries) return page;
	const bootstrapUrl = `${CHATGPT_ORIGIN}/.well-known/sickrat-session-bootstrap`;
	const fulfill = route => route.fulfill({
		status: 200,
		contentType: "text/html",
		body: "<!doctype html><title>Session bootstrap</title>",
	});
	await page.route(bootstrapUrl, fulfill);
	try {
		await page.goto(bootstrapUrl, { waitUntil: "commit" });
		await page.evaluate(storageEntries => {
			window.sessionStorage.clear();
			for (const [key, value] of Object.entries(storageEntries)) {
				window.sessionStorage.setItem(key, value);
			}
		}, entries);
	} finally {
		await page.unroute(bootstrapUrl, fulfill);
	}
	return page;
}

async function attemptDirectRequest(bundle, url, headers) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const client = new BrowserSessionHttpClient(bundle, {
			fetchImpl: (target, init) => fetch(target, { ...init, signal: controller.signal }),
		});
		const { response, requestMetadata } = await client.get(url, { headers });
		const result = {
			status: response.status,
			contentType: response.headers.get("content-type"),
			collectionDetected: false,
			requestMetadata,
		};
		if (!result.contentType?.toLowerCase().includes("application/json")) return result;
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) return result;
		const payload = JSON.parse(text);
		result.collectionDetected = findConversationCollection(payload) !== null;
		result.responseShape = describeJsonShape(payload);
		return result;
	} catch (error) {
		return {
			status: null,
			collectionDetected: false,
			errorCategory: error?.name === "AbortError" ? "timeout" : "request_failed",
		};
	} finally {
		clearTimeout(timeout);
	}
}

function selectCompatibilityHeaders(headers) {
	const selected = {};
	for (const name of ["accept", "accept-language", "referer", "user-agent"]) {
		if (typeof headers?.[name] === "string") selected[name] = headers[name];
	}
	return selected;
}

function summarizeBundle(bundle) {
	return {
		formatVersion: bundle.formatVersion,
		allowedOriginCount: bundle.allowedOrigins.length,
		cookieCount: bundle.storageState.cookies.length,
		localStorageEntryCount: bundle.storageState.origins.reduce(
			(total, origin) => total + (origin.localStorage?.length ?? 0),
			0,
		),
		indexedDbDatabaseCount: bundle.storageState.origins.reduce(
			(total, origin) => total + (origin.indexedDB?.length ?? 0),
			0,
		),
		sessionStorageEntryCount: Object.values(bundle.sessionStorageByOrigin ?? {}).reduce(
			(total, entries) => total + Object.keys(entries).length,
			0,
		),
		capturedAt: bundle.capturedAt,
	};
}

function cookieMatchesAllowedOrigin(cookie) {
	const domain = cookie.domain.replace(/^\./, "").toLowerCase();
	return SESSION_IDENTITY.allowedOrigins.some(origin => {
		const hostname = new URL(origin).hostname.toLowerCase();
		return hostname === domain || hostname.endsWith(`.${domain}`);
	});
}

function sanitizeEndpoint(rawUrl) {
	const url = new URL(rawUrl);
	const parameterNames = [...new Set(url.searchParams.keys())].sort();
	return `${url.origin}${url.pathname}${parameterNames.length > 0 ? `?${parameterNames.join("&")}` : ""}`;
}

async function closeContext(context) {
	activeContexts.delete(context);
	await context.close().catch(() => {});
}

function createCleanup(browserInstance, contexts) {
	let cleanupPromise;
	return () => {
		cleanupPromise ??= (async () => {
			const openContexts = [...contexts];
			contexts.clear();
			await Promise.allSettled(openContexts.map(context => context.close()));
			await browserInstance.close().catch(() => {});
		})();
		return cleanupPromise;
	};
}

function installSignalCleanup(cleanupBrowser) {
	const handlers = new Map();
	for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
		const handler = () => void cleanupBrowser().finally(() => process.exit(exitCode));
		handlers.set(signal, handler);
		process.once(signal, handler);
	}
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}

function numberEnv(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}
