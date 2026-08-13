import assert from "node:assert/strict";
import test from "node:test";

import {
	BrowserSessionHttpClient,
	describeJsonShape,
	findConversationCollection,
	sanitizeObservedRequestHeaders,
	selectCookies,
} from "./session-http-client.mjs";

const now = Date.parse("2026-07-23T12:00:00.000Z");

test("selects only unexpired, unpartitioned cookies that match origin, path, and transport", () => {
	const selection = selectCookies([
		cookie({ name: "host", domain: "chatgpt.com", path: "/" }),
		cookie({ name: "domain", domain: ".chatgpt.com", path: "/backend-api" }),
		cookie({ name: "wrong-domain", domain: ".example.com" }),
		cookie({ name: "wrong-path", path: "/other" }),
		cookie({ name: "expired", expires: now / 1000 - 1 }),
		cookie({ name: "partitioned", partitionKey: "https://chatgpt.com" }),
	], new URL("https://chatgpt.com/backend-api/conversations"), now);

	assert.equal(selection.header, "domain=value; host=value");
	assert.equal(selection.includedCount, 2);
	assert.equal(selection.excludedPartitionedCount, 1);
});

test("confines requests to the bundle origin and never follows redirects implicitly", async () => {
	const calls = [];
	const client = new BrowserSessionHttpClient(bundle(), {
		now: () => now,
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), cookie: init.headers.get("cookie") });
			return new Response(null, {
				status: 302,
				headers: { location: "https://chatgpt.com/next" },
			});
		},
	});

	await assert.rejects(
		client.get("https://chatgpt.com/backend-api/conversations"),
		/explicit same-origin redirect handling/,
	);
	await assert.rejects(
		client.get("https://example.com/private"),
		/outside the immutable origin allowlist/,
	);
	assert.deepEqual(calls, [{
		url: "https://chatgpt.com/backend-api/conversations",
		cookie: "session=value",
	}]);
});

test("sanitizes browser-observed headers without exposing cookie transport twice", () => {
	assert.deepEqual(sanitizeObservedRequestHeaders({
		accept: "application/json",
		authorization: "Bearer in-memory-only",
		cookie: "session=secret",
		host: "chatgpt.com",
		"x-provider-proof": "proof",
		"x-invalid": "line\nbreak",
	}), {
		accept: "application/json",
		authorization: "Bearer in-memory-only",
		"x-provider-proof": "proof",
	});
});

test("detects a conversation collection and emits only schema shape", () => {
	const payload = {
		items: [{
			id: "private-id",
			title: "private-title",
			create_time: 123,
			mapping: { private: "content" },
		}],
		total: 1,
	};
	const collection = findConversationCollection(payload);
	const shape = describeJsonShape(payload);

	assert.equal(collection.arrayField, "items");
	assert.equal(collection.idField, "id");
	assert.equal(collection.titleField, "title");
	assert.deepEqual(collection.temporalFields, ["create_time"]);
	assert.deepEqual(shape.keys, ["items", "total"]);
	assert.doesNotMatch(JSON.stringify(shape), /private-(id|title)|content/);
});

test("does not mistake the prompt library for conversation history", () => {
	const payload = {
		items: [{
			id: "prompt-id",
			title: "Prompt title",
			description: "A reusable prompt",
			prompt: "Prompt contents",
		}],
		total: 1,
	};

	assert.equal(findConversationCollection(payload), null);
});

test("does not mistake scheduled tasks for conversation history", () => {
	const payload = {
		tasks: [{
			conversation_id: "conversation-id",
			title: "Task title",
			created_at: "2026-07-24T08:00:00Z",
			updated_at: "2026-07-24T08:01:00Z",
			messages: [{ content: "private" }],
		}],
	};

	assert.equal(findConversationCollection(payload), null);
});

function bundle() {
	return {
		formatVersion: 1,
		allowedOrigins: ["https://chatgpt.com"],
		storageState: {
			cookies: [cookie({ name: "session" })],
			origins: [],
		},
	};
}

function cookie(overrides = {}) {
	return {
		name: "name",
		value: "value",
		domain: "chatgpt.com",
		path: "/",
		expires: -1,
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		...overrides,
	};
}
