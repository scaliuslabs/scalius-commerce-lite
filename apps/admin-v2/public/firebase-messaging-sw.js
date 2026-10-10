// Retired. Staff notifications use the dashboard's own Web Push worker
// (web-push-sw.js). A browser that registered the old Firebase worker fetches
// this file on its next update check: it unregisters itself, so the browser
// drops the old subscription and never shows a notification twice.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});
