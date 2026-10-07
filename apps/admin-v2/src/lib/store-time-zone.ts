/**
 * The store's time zone and country in the dashboard (Settings → Store
 * details → Store defaults; the country is the backup market's). Every staff
 * date, report day and file name is store time, as in Shopify, never the
 * viewer's device zone; numbers and dates are written, and weeks start, as in
 * the store's country (CLDR, `@scalius/shared/locale-format`). The dashboard
 * serves one store, so one value per tab: the store-defaults read sets them
 * (`syncStoreDefaults`), and the last values are kept in localStorage so the
 * next visit formats correctly before that read returns. Components re-render
 * through `useStoreDefaultsVersion` (and every `useMessages` catalog).
 */
import { useSyncExternalStore } from "react";
// The small defaults module, not the calendar math: this file is in the first chunk.
import { DEFAULT_STORE_TIME_ZONE, isValidTimeZone } from "@scalius/shared/store-defaults";

const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when the store's zone or country changes (`useMessages` and the date picker use it). */
export function useStoreDefaultsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** One store fact kept for the tab and in localStorage, read before the first render. */
function storeSetting(key: string, valid: (value: unknown) => value is string, fallback: string) {
  let value = fallback;
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (valid(stored)) value = stored;
  } catch {
    // Storage blocked: the default until the store-defaults read.
  }
  return {
    get: () => value,
    set(next: string | null | undefined) {
      if (!valid(next) || next === value) return;
      value = next;
      version += 1;
      try {
        globalThis.localStorage?.setItem(key, next);
      } catch {
        // Private mode: the value lasts for this tab only.
      }
      for (const listener of listeners) listener();
    },
  };
}

const timeZone = storeSetting("scalius.dashboard.storeTimeZone", isValidTimeZone, DEFAULT_STORE_TIME_ZONE);
/** Bangladesh, as `DEFAULT_STORE_REGION` (not imported: the formatting layer's own constant). */
const region = storeSetting("scalius.dashboard.storeRegion", (value): value is string => typeof value === "string" && /^[A-Z]{2}$/.test(value), "BD");

export const getStoreTimeZone: () => string = timeZone.get;
export const setStoreTimeZone: (zone: string | null | undefined) => void = timeZone.set;

/** The store's country (ISO 3166-1 alpha-2): Bangladesh until the store-defaults read says otherwise. */
export const getStoreRegion: () => string = region.get;
export const setStoreRegion: (country: string | null | undefined) => void = region.set;
