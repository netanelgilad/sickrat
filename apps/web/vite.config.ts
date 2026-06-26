import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	plugins: [
		tailwindcss(),
		react(),
		cloudflare(),
		VitePWA({
			strategies: "injectManifest",
			srcDir: "src",
			filename: "sw.ts",
			registerType: "prompt",
			injectRegister: "auto",
			includeAssets: ["icons/icon.svg"],
			manifest: {
				id: "/",
				name: "Sickrat",
				short_name: "Sickrat",
				description: "User-owned secrets approval vault for agents.",
				theme_color: "#17221f",
				background_color: "#f5f1e8",
				display: "standalone",
				start_url: "/",
				scope: "/",
				icons: [
					{
						src: "/icons/icon.svg",
						sizes: "512x512",
						type: "image/svg+xml",
						purpose: "any maskable",
					},
				],
			},
			workbox: {
				cleanupOutdatedCaches: true,
				navigateFallbackDenylist: [/^\/api\//],
			},
			devOptions: {
				enabled: false,
			},
		}),
	],
});
