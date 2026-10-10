import { useEffect, useRef, useSyncExternalStore } from "react";
import { isOnline } from "./failure";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Whether the browser says it is connected, kept current by its online and offline events. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

/** Runs `retry` once when the connection comes back, while `enabled`. */
export function useRetryWhenOnline(retry: (() => void) | undefined, enabled: boolean): void {
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => latest.current?.();
    window.addEventListener("online", onOnline, { once: true });
    return () => window.removeEventListener("online", onOnline);
  }, [enabled]);
}
