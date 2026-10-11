// Browser notifications for a signed-in buyer (Web Push). The store registers
// this worker from Account > Profile when the buyer turns notifications on.
// It does nothing else: no fetch handler, no caching, no page control.
//
// A push carries JSON { title, body, url?, tag? }. The notification shows the
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

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {};
  }
  if (!data || typeof data !== "object") data = {};
  // A browser requires every push to show something: without a title, show the store's address.
  var title = text(data.title, 120) || self.location.hostname;
  var options = {
    body: text(data.body, 300),
    icon: ICON,
    data: { url: typeof data.url === "string" ? sameOriginPath(data.url) : "" },
  };
  var tag = text(data.tag, 80);
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
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
