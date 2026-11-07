import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The historical package/artifact paths are retained for CLI update compatibility.
// This builds the vault API and a handoff page, not a browser application.
export default defineConfig({ plugins: [cloudflare()] });
