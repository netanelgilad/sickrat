/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

type PendingApproval = {
	id: string;
	device: string;
	command: string;
	secretRefs: string[];
};

async function navigateVisibleClients(url: string) {
	const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	for (const client of clients) {
		if (new URL(client.url).origin !== self.location.origin) continue;
		if (client.visibilityState !== "visible" && !client.focused) continue;
		client.postMessage({ type: "SICKRAT_NAVIGATE", url });
		try {
			if ("navigate" in client) await client.navigate(url);
		} catch {
			// iOS may reject navigation from a foreground notification path; postMessage is the fallback.
		}
	}
}

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") {
		self.skipWaiting();
	}
});

self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			let approval: PendingApproval | null = null;

			try {
				const subscription = await self.registration.pushManager.getSubscription();
				if (subscription) {
					const response = await fetch("/api/approvals/latest", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ endpoint: subscription.endpoint }),
					});
					if (response.ok) {
						const body = (await response.json()) as { approval: PendingApproval | null };
						approval = body.approval;
					}
				}
			} catch {
				approval = null;
			}

			const title = approval ? "Secret access requested" : "Sickrat";
			const body = approval
				? `${approval.device} wants ${approval.secretRefs.length} secrets`
				: "Open Sickrat to review the latest request.";
			const url = new URL(approval ? `/?request=${encodeURIComponent(approval.id)}` : "/", self.location.origin).href;

			await self.registration.showNotification(title, {
				body,
				badge: "/icons/icon.svg",
				icon: "/icons/icon.svg",
				tag: approval?.id ?? "sickrat-request",
				data: { approvalId: approval?.id ?? null, url },
			});

			if (approval) {
				await navigateVisibleClients(url);
			}
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const dataUrl = event.notification.data?.url ?? "/";
	const targetUrl = new URL(dataUrl, self.location.origin);
	const target = targetUrl.origin === self.location.origin ? targetUrl.href : self.location.origin;

	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
			for (const client of clients) {
				if ("focus" in client && new URL(client.url).origin === self.location.origin) {
					let focused = client;
					try {
						if ("navigate" in client) {
							focused = (await client.navigate(target)) ?? client;
						}
					} catch {
						focused = client;
					}
					focused.postMessage({ type: "SICKRAT_NAVIGATE", url: target });
					await focused.focus();
					return;
				}
			}
			await self.clients.openWindow(target);
		}),
	);
});
