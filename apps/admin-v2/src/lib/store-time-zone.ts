/**
 * The store's time zone in the dashboard (Settings → Store details → Store
 * defaults). Every staff date, report day and file name is store time, as in
 * Shopify, never the viewer's device zone. The dashboard serves one store, so
 * one value per tab: the store-defaults read sets it (`syncStoreDefaults`), and
 * the last value is kept in localStorage so the next visit formats correctly
 * before that read returns. Components re-render through `useStoreTimeZone`
 * (and every `useMessages` catalog).
 */
import { useSyncExternalStore } from "react";
// The small defaults module, not the calendar math: this file is in the first chunk.
import { DEFAULT_STORE_TIME_ZONE, isValidTimeZone } from "@scalius/shared/store-defaults";

const STORAGE_KEY = "scalius.dashboard.storeTimeZone";
const listeners = new Set<() => void>();

function readStored(): string {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isValidTimeZone(stored) ? stored : DEFAULT_STORE_TIME_ZONE;
  } catch {
    return DEFAULT_STORE_TIME_ZONE;
  }
}

let current = readStored();

export function getStoreTimeZone(): string {
  return current;
}

export function setStoreTimeZone(timeZone: string | null | undefined): void {
  if (!isValidTimeZone(timeZone) || timeZone === current) return;
  current = timeZone;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, timeZone);
  } catch {
    // Private mode: the zone lasts for this tab only.
  }
  for (const listener of listeners) listener();
}

export function subscribeStoreTimeZone(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The store's time zone; re-renders when it changes. */
export function useStoreTimeZone(): string {
  return useSyncExternalStore(subscribeStoreTimeZone, getStoreTimeZone, () => DEFAULT_STORE_TIME_ZONE);
}
