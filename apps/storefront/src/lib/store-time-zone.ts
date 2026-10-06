// The store's time zone for buyer-facing dates (orders, reviews, blog posts,
// messages): server renders read it from the request's layout payload; browser
// code reads the `data-store-time-zone` attribute Layout.astro puts on <html>.
// Neither is the buyer's device zone or the Worker's (UTC).
import { DEFAULT_STORE_TIME_ZONE, isValidTimeZone } from "@scalius/shared/commerce-time";
import { getRuntimeStoreTimeZone } from "./api/runtime";

export function storeTimeZone(): string {
  const server = getRuntimeStoreTimeZone();
  if (server) return server;
  if (typeof document !== "undefined") {
    const attribute = document.documentElement.dataset.storeTimeZone;
    if (isValidTimeZone(attribute)) return attribute;
  }
  return DEFAULT_STORE_TIME_ZONE;
}
