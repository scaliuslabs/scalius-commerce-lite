// The store's time zone for one request, for the few deep reads that cannot
// take it as a parameter: a customer segment's calendar-date filter evaluated
// inside checkout pricing. The API sets it from the platform settings resolved
// at Worker entry (`env.PLATFORM_CONFIG.timeZone`), beside the public media
// URL; every other merchant-calendar read takes the zone as an argument.
// AsyncLocalStorage keeps concurrent requests apart; nothing is retained.
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeTimeZone } from "@scalius/shared/commerce-time";

const storeTimeZoneContext = new AsyncLocalStorage<string>();

/** Runs `callback` with the store's time zone available to `currentStoreTimeZone()`. */
export function withStoreTimeZone<T>(timeZone: string | null | undefined, callback: () => T): T {
  return storeTimeZoneContext.run(normalizeTimeZone(timeZone), callback);
}

/** The request's store time zone; the default zone outside a request scope. */
export function currentStoreTimeZone(): string {
  return normalizeTimeZone(storeTimeZoneContext.getStore());
}
