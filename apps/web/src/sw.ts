/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

type PendingApproval = {
	id: string;
	device: string;
	command: string;
	secretRefs: string[];
	resourceRequests: Array<{ type: "secret" | "oauth_token" }>;
	approvalWaitSeconds: number | null;
};

type PendingPairing = {
	code: string;
	label: string;
	expiresAt: string;
};

type PendingNotification =
	| {
			type: "approval.requested";
			approval: PendingApproval;
			url: string;
	  }
	| {
			type: "pairing.requested";
			pairing: PendingPairing;
			url: string;
	  };

async function notifyVisibleClients(payload: { url: string; title: string; body: string }) {
	const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	let delivered = false;
	for (const client of clients) {
		if (new URL(client.url).origin !== self.location.origin) continue;
		if (client.visibilityState !== "visible" && !client.focused) continue;
		client.postMessage({ type: "SICKRAT_NOTIFICATION", ...payload });
		delivered = true;
	}
	return delivered;
}

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

function formatDuration(seconds: number) {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") {
		self.skipWaiting();
	}
});

self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			let notification: PendingNotification | null = null;

			try {
				const subscription = await self.registration.pushManager.getSubscription();
				if (subscription) {
					const response = await fetch("/api/notifications/latest", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ endpoint: subscription.endpoint }),
					});
					if (response.ok) {
						const body = (await response.json()) as { notification: PendingNotification | null };
						notification = body.notification;
					}
				}
			} catch {
				notification = null;
			}

			let title = "Sickrat";
			let body = "Open Sickrat to review the latest request.";
			let tag = "sickrat-request";
			if (notification?.type === "approval.requested") {
				title = "Vault access requested";
				body = `${notification.approval.device} wants ${notification.approval.resourceRequests.length} resources`;
				if (notification.approval.approvalWaitSeconds) body += `, waiting ${formatDuration(notification.approval.approvalWaitSeconds)}`;
				tag = notification.approval.id;
			} else if (notification?.type === "pairing.requested") {
				title = "Pairing requested";
				body = `${notification.pairing.label} wants to pair with this vault`;
				tag = notification.pairing.code;
			}
			const url = new URL(notification?.url ?? "/", self.location.origin).href;

			if (notification && (await notifyVisibleClients({ url, title, body }))) {
				return;
			}

			await self.registration.showNotification(title, {
				body,
				badge: "/icons/icon.svg",
				icon: "/icons/icon.svg",
				tag,
				data: { url },
			});
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
