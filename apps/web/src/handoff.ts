// No credentials or vault keys are read here. Only public navigation is handed off.
const url = new URL("sickrat://open");
url.searchParams.set("origin", location.origin);
url.searchParams.set("path", location.pathname + location.search);
(document.getElementById("open") as HTMLAnchorElement).href = url.href;
document.getElementById("origin")!.textContent = location.origin;

// Retire the old offline app without deleting its local passkey recovery records.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async registrations => {
    for (const registration of registrations) {
      if (registration.scope === location.origin + "/") await registration.unregister();
    }
  }).catch(() => {});
}
