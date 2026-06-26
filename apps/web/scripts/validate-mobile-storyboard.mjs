import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.MOBILE_STORYBOARD_URL ?? "http://127.0.0.1:5173";
const capture = process.env.CAPTURE_MOBILE_STORYBOARD === "1";
const screenshotDir = process.env.MOBILE_STORYBOARD_SCREENSHOT_DIR ?? "/tmp/sickrat-mobile-storyboard";
const viewport = { width: 402, height: 874 };

const states = [
	"install",
	"push",
	"home-ready",
	"approval",
	"missing-secret",
	"pairing",
	"locked",
	"approved",
	"empty",
];

if (capture) await mkdir(screenshotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

try {
	for (const state of states) {
		const page = await browser.newPage({
			hasTouch: true,
			isMobile: true,
			viewport,
		});
		const url = new URL("/storyboard", baseUrl);
		url.searchParams.set("state", state);

		await page.goto(url.toString(), { waitUntil: "networkidle" });
		await page.waitForSelector(".phone-frame", { timeout: 10_000 });

		if (capture) {
			await page.screenshot({
				path: path.join(screenshotDir, `${state}-${viewport.width}x${viewport.height}.png`),
			});
		}

		const result = await page.evaluate((expectedState) => {
			const frame = document.querySelector(".phone-frame")?.getBoundingClientRect();
			const screen = document.querySelector(".story-phone-screen")?.getBoundingClientRect();
			const active = document.querySelector(".story-rail button.active")?.textContent?.trim().replace(/\s+/g, " ");
			const bodyText = document.body.textContent ?? "";

			return {
				active,
				frameHeight: frame ? Math.round(frame.height) : null,
				frameTop: frame ? Math.round(frame.top) : null,
				frameWidth: frame ? Math.round(frame.width) : null,
				hasBackendLeak: /\b(D1|Worker|VAPID|control-plane|Durable Object|Cloudflare D1|Cloudflare Worker)\b/i.test(bodyText),
				overflowX: document.body.scrollWidth > document.documentElement.clientWidth,
				screenHeight: screen ? Math.round(screen.height) : null,
				screenWidth: screen ? Math.round(screen.width) : null,
				state: expectedState,
			};
		}, state);

		results.push(result);
		await page.close();
	}
} finally {
	await browser.close();
}

const failures = results.filter((result) => {
	return (
		result.overflowX ||
		result.hasBackendLeak ||
		!result.active ||
		!result.frameWidth ||
		!result.frameHeight ||
		result.frameTop == null ||
		result.frameTop >= viewport.height ||
		!result.screenWidth ||
		!result.screenHeight
	);
});

console.log(
	JSON.stringify(
		{
			baseUrl,
			capture,
			failures,
			screenshotDir: capture ? screenshotDir : null,
			states: results,
			viewport,
		},
		null,
		2,
	),
);

if (failures.length > 0) {
	process.exitCode = 1;
}
