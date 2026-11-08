// acme.pixel's pixel: each event, as the store hands it to this app, to the
// collector (one beacon per event; it outlives a page that is navigating away).

import { definePixel } from "@scalius/plugin-sdk/pixel";

export default definePixel((pixel) => {
  const account = typeof pixel.settings.account_id === "string" ? pixel.settings.account_id : "";
  pixel.on("*", (event) => {
    const body = JSON.stringify({ account, id: event.id, name: event.name, at: event.timestamp, data: event.data, page: event.context.page.path, visitor: event.context.visitorId });
    if (!navigator.sendBeacon?.("https://collect.acme.example/v1/events", body)) {
      void fetch("https://collect.acme.example/v1/events", { method: "POST", body, keepalive: true }).catch(() => undefined);
    }
  });
});
