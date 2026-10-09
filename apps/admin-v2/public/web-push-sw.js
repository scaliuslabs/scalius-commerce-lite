// Web Push service worker for the dashboard's staff notifications (My account →
// "Notifications on this device"). The page registers it with a scope of its own
// (`<dashboard base>/web-push/`). The server sends a JSON payload
// `{ title, body, url?, tag? }`; `url` is an absolute dashboard address.

// This file sits at the dashboard root, e.g. "/" or "/dashboard/".
const dashboardRoot = new URL("./", self.location.href).href;
const icon = new URL("favicon.png", dashboardRoot).href;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const text = (value) => (typeof value === "string" ? value : "");
  const title = text(payload.title) || "Scalius";
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body: text(payload.body),
        icon,
        badge: icon,
        tag: text(payload.tag) || undefined,
        data: { url: text(payload.url) },
      });
      // Open dashboard tabs list it in the bell too (components/admin/NotificationDropdown.tsx).
      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const tab of windows) {
        if (tab.url.startsWith(dashboardRoot)) tab.postMessage({ type: "scalius:push", title, body: text(payload.body), url: text(payload.url) });
      }
    })(),
  );
});

/** A dashboard address from the payload; anything else opens the dashboard. */
function targetOf(value) {
  try {
    const url = new URL(value, dashboardRoot);
    return url.origin === new URL(dashboardRoot).origin ? url.href : dashboardRoot;
  } catch {
    return dashboardRoot;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = targetOf(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = windows.find((client) => client.url.startsWith(dashboardRoot));
      if (tab) {
        try {
          // A tab this worker does not control cannot be moved; then a new one opens.
          const shown = tab.url === target ? tab : await tab.navigate(target);
          if (shown) {
            await shown.focus();
            return;
          }
        } catch {
          // fall through to a new tab
        }
      }
      if (clients.openWindow) await clients.openWindow(target);
    })(),
  );
});
