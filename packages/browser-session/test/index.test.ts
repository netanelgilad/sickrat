import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	assertBrowserSessionBundle,
	decodeLengthPrefixedJson,
	encodeLengthPrefixedJson,
	isBrowserSessionResult,
	readLengthPrefixedJson,
	writeLengthPrefixedJson,
} from "../src/index.ts";

const bundle = {
	cookies: [
		{
			name: "session",
			value: "private",
			domain: ".example.com",
			path: "/",
			expires: 2_000_000_000,
			httpOnly: true,
			secure: true,
			sameSite: "Lax" as const,
		},
	],
	origins: [
		{
			origin: "https://example.com",
			localStorage: [{ name: "auth", value: "private" }],
			indexedDB: { databases: [] },
		},
	],
};

test("validates the provider-neutral bundle and rejects removed metadata", () => {
	assert.doesNotThrow(() => assertBrowserSessionBundle(bundle));
	assert.throws(() => assertBrowserSessionBundle({ ...bundle, formatVersion: 1 }));
	assert.throws(() => assertBrowserSessionBundle({ cookies: [] }));
	assert.throws(() => assertBrowserSessionBundle({ origins: [{ origin: "https://example.com/path", localStorage: [{ name: "a", value: "b" }] }] }));
});

test("encodes and decodes exactly one framed JSON value", () => {
	const frame = encodeLengthPrefixedJson({ action: "commit", bundle });
	assert.deepEqual(decodeLengthPrefixedJson(frame), { action: "commit", bundle });
	assert.throws(() => decodeLengthPrefixedJson(frame.subarray(0, frame.length - 1)), /length/);
	assert.throws(() => decodeLengthPrefixedJson(Buffer.concat([frame, Buffer.from([0])])), /length/);
});

test("stream framing reads the header before allocating and rejects trailing data", async () => {
	const channel = new PassThrough();
	const reading = readLengthPrefixedJson(channel);
	await writeLengthPrefixedJson(channel, { action: "abort", safeReasonCode: "unchanged" });
	assert.deepEqual(await reading, { action: "abort", safeReasonCode: "unchanged" });

	const trailing = new PassThrough();
	const invalid = readLengthPrefixedJson(trailing);
	trailing.end(Buffer.concat([encodeLengthPrefixedJson({ ok: true }), Buffer.from([1])]));
	await assert.rejects(invalid, /trailing/);
});

test("validates commit and safe abort results", () => {
	assert.equal(isBrowserSessionResult({ action: "commit", bundle }), true);
	assert.equal(isBrowserSessionResult({ action: "abort", safeReasonCode: "reauth_required" }), true);
	assert.equal(isBrowserSessionResult({ action: "abort", safeReasonCode: "cookies=private" }), false);
});
