import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Readable, Writable } from "node:stream";
import {
	isBrowserSessionResult,
	readLengthPrefixedJson,
	writeLengthPrefixedJson,
	type BrowserSessionInput,
} from "../src/index.ts";

const exampleDirectory = fileURLToPath(new URL("../examples/", import.meta.url));

async function runSyntheticChild(script: string, input: BrowserSessionInput) {
	const child = spawn(process.execPath, ["--experimental-strip-types", `${exampleDirectory}${script}`], {
		env: {
			PATH: process.env.PATH,
			SICKRAT_BROWSER_SESSION_INPUT_FD: "3",
			SICKRAT_BROWSER_SESSION_OUTPUT_FD: "4",
		},
		stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
	});
	const output = child.stdio[4] as Readable;
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => { stderr += chunk; });
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	await writeLengthPrefixedJson(child.stdio[3] as Writable, input);
	const result = await readLengthPrefixedJson(output);
	assert.equal(await exited, 0, stderr);
	assert.equal(stderr, "");
	if (!isBrowserSessionResult(result)) throw new Error("Synthetic child returned an invalid result.");
	return result;
}

test("synthetic producer, later consumer, and abort use only inherited pipes", async () => {
	const created = await runSyntheticChild("synthetic-producer.mjs", {
		resourceRef: "browser-session/synthetic/primary",
		access: "create",
	});
	assert.equal(created.action, "commit");
	if (created.action !== "commit") return;
	assert.equal(created.bundle.cookies?.[0]?.value, "synthetic-secret-one");

	const updated = await runSyntheticChild("synthetic-consumer.mjs", {
		resourceRef: "browser-session/synthetic/primary",
		access: "restore_and_update",
		bundle: created.bundle,
	});
	assert.equal(updated.action, "commit");
	if (updated.action !== "commit") return;
	assert.equal(updated.bundle.cookies?.[0]?.value, "synthetic-secret-two");

	const aborted = await runSyntheticChild("synthetic-abort.mjs", {
		resourceRef: "browser-session/synthetic/primary",
		access: "restore_and_update",
		bundle: updated.bundle,
	});
	assert.deepEqual(aborted, { action: "abort", safeReasonCode: "unchanged" });
});
