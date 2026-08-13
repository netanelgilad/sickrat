#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadEncryptedBundle } from "./encrypted-bundle-store.mjs";
import {
	BrowserSessionHttpClient,
	describeJsonShape,
	findConversationCollection,
	sanitizeObservedRequestHeaders,
} from "./session-http-client.mjs";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_CONVERSATION_COLLECTION_PATH = "/backend-api/conversations";
const REQUEST_TIMEOUT_MS = numberEnv("CHATGPT_SPIKE_REQUEST_TIMEOUT_MS", 60_000);
const MAX_JSON_BYTES = numberEnv("CHATGPT_SPIKE_MAX_JSON_BYTES", 10_000_000);
const SESSION_ENCRYPTION_SECRET = process.env.CHATGPT_SESSION_ENCRYPTION_KEY;
const SESSION_CHECKPOINT_PATH = process.env.CHATGPT_SESSION_BUNDLE_PATH
	|| fileURLToPath(new URL("./artifacts/chatgpt-primary.bundle.enc", import.meta.url));

if (!SESSION_ENCRYPTION_SECRET) {
	throw new Error("CHATGPT_SESSION_ENCRYPTION_KEY must be injected by Sickrat.");
}

const bundle = await loadEncryptedBundle(SESSION_CHECKPOINT_PATH, SESSION_ENCRYPTION_SECRET);
if (!bundle) throw new Error("The encrypted ChatGPT session checkpoint does not exist.");
const profile = bundle.httpProfiles?.conversationList;
validateConversationListProfile(profile);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
timeout.unref?.();
try {
	const client = new BrowserSessionHttpClient(bundle, {
		fetchImpl: (target, init) => fetch(target, { ...init, signal: controller.signal }),
	});
	const { response, requestMetadata } = await client.get(profile.url, {
		headers: sanitizeObservedRequestHeaders(profile.headers),
	});
	const contentType = response.headers.get("content-type");
	const text = await response.text();
	if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
		throw new Error("The ChatGPT conversation-list response exceeded the configured limit.");
	}
	const payload = contentType?.toLowerCase().includes("application/json")
		? JSON.parse(text)
		: null;
	const collectionDetected = findConversationCollection(payload) !== null;

	console.log(JSON.stringify({
		success: response.status === 200 && collectionDetected,
		provider: "chatgpt",
		experimentalUnsupportedWebApi: true,
		browserLaunched: false,
		sessionCheckpointLoaded: true,
		request: {
			endpoint: sanitizeEndpoint(profile.url),
			method: "GET",
			requestMetadata,
		},
		response: {
			status: response.status,
			contentType,
			collectionDetected,
			...(payload ? { shape: describeJsonShape(payload) } : {}),
		},
		privacy: {
			conversationBodiesPersisted: false,
			conversationIdentifiersPersisted: false,
			plaintextSessionStatePersisted: false,
			requestHeaderValuesLogged: false,
		},
	}, null, 2));

	if (response.status !== 200 || !collectionDetected) process.exitCode = 1;
} finally {
	clearTimeout(timeout);
}

function validateConversationListProfile(profile) {
	if (
		!profile
		|| profile.formatVersion !== 1
		|| profile.method !== "GET"
		|| !profile.headers
	) {
		throw new Error("The encrypted bundle has no supported conversation-list HTTP profile.");
	}
	const url = new URL(profile.url);
	if (url.origin !== CHATGPT_ORIGIN || url.pathname !== CHATGPT_CONVERSATION_COLLECTION_PATH) {
		throw new Error("The encrypted conversation-list profile is outside its exact provider route.");
	}
}

function sanitizeEndpoint(rawUrl) {
	const url = new URL(rawUrl);
	const parameterNames = [...new Set(url.searchParams.keys())].sort();
	return `${url.origin}${url.pathname}${parameterNames.length > 0 ? `?${parameterNames.join("&")}` : ""}`;
}

function numberEnv(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}
