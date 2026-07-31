import { openGrantedBrowserSession } from "../src/index.ts";

const transaction = openGrantedBrowserSession();
const input = await transaction.read();
if (input.access !== "create" && input.access !== "replace") {
	throw new Error("Synthetic producer requires create or replace access.");
}
await transaction.commit({
	cookies: [
		{
			name: "synthetic_session",
			value: "synthetic-secret-one",
			domain: ".example.test",
			path: "/",
			expires: 2_000_000_000,
			httpOnly: true,
			secure: true,
			sameSite: "Lax",
		},
	],
	origins: [
		{
			origin: "https://example.test",
			localStorage: [{ name: "synthetic_auth", value: "synthetic-private-one" }],
		},
	],
});
