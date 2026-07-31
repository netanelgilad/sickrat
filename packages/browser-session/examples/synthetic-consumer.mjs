import { openGrantedBrowserSession } from "../src/index.ts";

const transaction = openGrantedBrowserSession();
const input = await transaction.read();
if (input.access !== "restore_and_update" || !input.bundle) {
	throw new Error("Synthetic consumer requires a restorable bundle.");
}
const cookies = input.bundle.cookies?.map((cookie) =>
	cookie.name === "synthetic_session"
		? { ...cookie, value: "synthetic-secret-two" }
		: cookie,
);
await transaction.commit({ ...input.bundle, cookies });
