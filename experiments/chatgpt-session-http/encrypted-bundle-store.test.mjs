import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	loadEncryptedBundle,
	saveEncryptedBundle,
} from "./encrypted-bundle-store.mjs";

test("persists only authenticated ciphertext and restores the bundle with the granted key", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bundle-store-"));
	const filePath = path.join(directory, "session.enc");
	const bundle = fixtureBundle();
	try {
		await saveEncryptedBundle(filePath, bundle, "correct horse battery staple");
		const stored = await readFile(filePath, "utf8");

		assert.doesNotMatch(stored, /session-cookie-value|private-local-storage-value|in-memory-bearer/);
		assert.deepEqual(
			await loadEncryptedBundle(filePath, "correct horse battery staple"),
			bundle,
		);
		await assert.rejects(
			loadEncryptedBundle(filePath, "incorrect horse battery staple"),
		/authenticate data|Unsupported state|unable to authenticate/i,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("returns null when no encrypted checkpoint exists", async () => {
	assert.equal(
		await loadEncryptedBundle(
			path.join(os.tmpdir(), `missing-chatgpt-session-${process.pid}.enc`),
			"correct horse battery staple",
		),
		null,
	);
});

function fixtureBundle() {
	return {
		formatVersion: 1,
		providerId: "chatgpt",
		accountLabel: "primary",
		allowedOrigins: ["https://chatgpt.com"],
		browserFamily: "chromium",
		storageState: {
			cookies: [{
				name: "session",
				value: "session-cookie-value",
				domain: "chatgpt.com",
				path: "/",
				expires: -1,
				httpOnly: true,
				secure: true,
				sameSite: "Lax",
			}],
			origins: [{
				origin: "https://chatgpt.com",
				localStorage: [{ name: "private", value: "private-local-storage-value" }],
			}],
		},
		httpProfiles: {
			conversationList: {
				formatVersion: 1,
				method: "GET",
				url: "https://chatgpt.com/backend-api/conversations?limit=28",
				headers: {
					authorization: "Bearer in-memory-bearer",
				},
				capturedAt: "2026-07-24T08:00:00.000Z",
			},
		},
		capturedAt: "2026-07-24T08:00:00.000Z",
	};
}
