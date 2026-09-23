import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "orderlist-auto-refresh";
export const ORDER_AUTO_REFRESH_SECONDS = 60;
const DEBOUNCE_MS = 5_000;

function readEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/**
 * Refreshes only the visible order list every minute while it is switched on,
 * the tab is visible and nothing is paused (selection, open dialog, saving).
 */
export function useOrderAutoRefresh({
  refetch,
  isFetching,
  paused,
}: {
  refetch: () => Promise<unknown>;
  isFetching: boolean;
  paused: boolean;
}) {
  const [enabled, setEnabled] = useState(readEnabled);
  const refetchRef = useRef(refetch);
  const fetchingRef = useRef(isFetching);
  const pausedRef = useRef(paused);
  const inFlightRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  useEffect(() => {
    refetchRef.current = refetch;
    fetchingRef.current = isFetching;
    pausedRef.current = paused;
  });

  const refresh = useCallback((): boolean => {
    if (isHidden() || pausedRef.current) return false;
    if (fetchingRef.current || inFlightRef.current) return false;
    const now = Date.now();
    if (now - lastRefreshAtRef.current < DEBOUNCE_MS) return false;
    lastRefreshAtRef.current = now;
    inFlightRef.current = true;
    try {
      void Promise.resolve(refetchRef.current())
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
        });
    } catch {
      inFlightRef.current = false;
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let elapsed = 0;
    const interval = window.setInterval(() => {
      if (isHidden() || pausedRef.current) return;
      elapsed += 1;
      if (elapsed < ORDER_AUTO_REFRESH_SECONDS) return;
      elapsed = 0;
      refresh();
    }, 1_000);
    const onVisibilityChange = () => {
      if (isHidden()) return;
      elapsed = 0;
      refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, refresh]);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, String(next));
    } catch {
      // Private mode: the choice lasts for this page only.
    }
    if (next) refresh();
  }, [enabled, refresh]);

  return { enabled, toggle };
}
