// Web Push service worker for the dashboard's staff notifications (My account →
// "Notifications on this device"). The page registers it with a scope of its own
// (`<dashboard base>/web-push/`). The server sends a JSON payload
// `{ recipient, notification: { title, body, url?, tag? } }`; private content is
// shown only for the current staff session. `url` is an absolute dashboard address.

// This file sits at the dashboard root, e.g. "/" or "/dashboard/".
const dashboardRoot = new URL("./", self.location.href).href;
const icon = new URL("favicon.png", dashboardRoot).href;

self.addEventListener("install", () => {
  self.skipWaiting();
});

// Identity is read from the existing first-party session; payload data never authorizes display.
let signingOut = false;
let lastSignOutAt = 0;
let displayEpoch = 0;
const pendingDisplays = new Set();

async function closePushNotifications(throughEpoch, ownerId) {
  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    const data = notification.data;
    if (typeof data?.pushEpoch === "number" && data.pushEpoch > throughEpoch) continue;
    if (ownerId && data?.pushOwner && data.pushOwner !== ownerId) continue;
    notification.close();
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "scalius:push:sign-out") {
    signingOut = true;
    lastSignOutAt = Date.now();
    const closingEpoch = displayEpoch;
    displayEpoch += 1;
    event.waitUntil((async () => {
      await Promise.allSettled([...pendingDisplays]);
      await closePushNotifications(closingEpoch).catch(() => undefined);
      event.ports?.[0]?.postMessage({ ok: true });
    })());
  } else if (message.type === "scalius:push:enrolled") {
    const ok = typeof message.startedAt === "number" && message.startedAt > lastSignOutAt;
    if (ok) signingOut = false;
    event.ports?.[0]?.postMessage({ ok });
  }
});

async function ownsPush(recipient) {
  if (!recipient || recipient.audience !== "staff" || typeof recipient.id !== "string" || !recipient.id) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(new URL("api/auth/dashboard-session", dashboardRoot).href, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) return false;
    const session = await response.json();
    return session?.session?.user?.id === recipient.id && Array.isArray(session.session.permissions);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object") payload = {};
  const text = (value) => (typeof value === "string" ? value : "");
  event.waitUntil((async () => {
    const epoch = displayEpoch;
    const notification = payload.notification;
    if (signingOut || !notification || typeof notification !== "object" || !await ownsPush(payload.recipient)
      || signingOut || epoch !== displayEpoch) {
      await self.registration.showNotification("Scalius", { icon, badge: icon, tag: "scalius-private", data: { url: "" } });
      return;
    }
    const title = text(notification.title) || "Scalius";
    const tag = text(notification.tag);
    const display = self.registration.showNotification(title, {
      body: text(notification.body), icon, badge: icon,
      ...(tag ? { tag, renotify: true } : {}), data: { url: text(notification.url), pushEpoch: epoch, pushOwner: payload.recipient.id },
    });
    pendingDisplays.add(display);
    try { await display; } finally { pendingDisplays.delete(display); }
    if (signingOut || epoch !== displayEpoch || !await ownsPush(payload.recipient)) {
      await closePushNotifications(epoch, payload.recipient.id).catch(() => undefined);
      return;
    }
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (signingOut || epoch !== displayEpoch) return;
    // Tabs use this as a refresh signal; never send pushed account data to another open document.
    const receipt = { type: "scalius:push" };
    for (const tab of windows) if (tab.url.startsWith(dashboardRoot)) tab.postMessage(receipt);
  })());
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
