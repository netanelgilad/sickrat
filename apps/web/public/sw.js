// Final update for the retired PWA. Never clear localStorage/passkey records.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("workbox-precache")) await caches.delete(key);
    }
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) {
      if (new URL(client.url).origin === self.location.origin) await client.navigate(client.url);
    }
  })());
});
