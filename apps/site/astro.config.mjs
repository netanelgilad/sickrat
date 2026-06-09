import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://sickrat.dev",
	output: "static",
	adapter: cloudflare(),
	trailingSlash: "never",
});
