// Browser notifications for a signed-in buyer (Web Push). The store registers
// this worker from Account > Profile when the buyer turns notifications on.
// It does nothing else: no fetch handler, no caching, no page control.
//
// A push carries { recipient, notification: { title, body, url?, tag? } }. Private
// content is shown only for the current customer session. The notification shows the
// store's icon (the page passes it as ?icon=, an https or same-origin URL).
// A click focuses an open tab of the store, or opens `url`, which must be a
// path on this origin; anything else opens the store's front page.
"use strict";

var ICON = (function () {
  try {
    var raw = new URL(self.location.href).searchParams.get("icon");
    if (!raw) return undefined;
    var url = new URL(raw, self.location.origin);
    return url.origin === self.location.origin || url.protocol === "https:" ? url.href : undefined;
  } catch (error) {
    return undefined;
  }
})();

/** A same-origin path (with its query and fragment) from a pushed `url`, else "/". */
function sameOriginPath(value) {
  if (typeof value !== "string" || value.charAt(0) !== "/" || value.charAt(1) === "/" || value.charAt(1) === "\\") return "/";
  try {
    var url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : "/";
  } catch (error) {
    return "/";
  }
}

function text(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
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
  if (!recipient || recipient.audience !== "customer" || typeof recipient.id !== "string" || !recipient.id) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(new URL("/api/customer-auth/me", self.location.origin).href, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) return false;
    const session = await response.json();
    return session?.success === true && session?.data?.authenticated === true && session.data.customer?.customerId === recipient.id;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {};
  }
  if (!data || typeof data !== "object") data = {};
  event.waitUntil((async () => {
    const epoch = displayEpoch;
    const notification = data.notification;
    if (signingOut || !notification || typeof notification !== "object" || !await ownsPush(data.recipient)
      || signingOut || epoch !== displayEpoch) {
      await self.registration.showNotification(self.location.hostname, { icon: ICON, tag: "scalius-private", data: { url: "" } });
      return;
    }
    const title = text(notification.title, 120) || self.location.hostname;
    const options = { body: text(notification.body, 300), icon: ICON,
      data: { url: typeof notification.url === "string" ? sameOriginPath(notification.url) : "", pushEpoch: epoch, pushOwner: data.recipient.id } };
    const tag = text(notification.tag, 80);
    if (tag) { options.tag = tag; options.renotify = true; }
    const display = self.registration.showNotification(title, options);
    pendingDisplays.add(display);
    try { await display; } finally { pendingDisplays.delete(display); }
    if (signingOut || epoch !== displayEpoch || !await ownsPush(data.recipient)) {
      await closePushNotifications(epoch, data.recipient.id).catch(() => undefined);
    }
  })());
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var pushed = event.notification.data && event.notification.data.url;
  var target = typeof pushed === "string" && pushed ? sameOriginPath(pushed) : "";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      var open = windows.filter(function (client) {
        return new URL(client.url).origin === self.location.origin;
      });
      var exact = target
        ? open.filter(function (client) {
            var url = new URL(client.url);
            return url.pathname + url.search + url.hash === target;
          })[0]
        : undefined;
      if (exact) return exact.focus();
      var first = open[0];
      if (first && !target) return first.focus();
      if (first && typeof first.navigate === "function") {
        return first.focus().then(function (focused) {
          return (focused || first).navigate(target);
        });
      }
      return self.clients.openWindow(target || "/");
    }),
  );
});
