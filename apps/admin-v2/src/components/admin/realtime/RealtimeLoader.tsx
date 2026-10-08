/**
 * Loads the realtime bridge once the first page has rendered and the browser
 * is idle: the live connection is never part of a screen's first download.
 */
import { useEffect, useState, type ComponentType } from "react";

type BridgeProps = { userId: string; permissions: readonly string[] };

export function RealtimeLoader(props: BridgeProps) {
  const [Bridge, setBridge] = useState<ComponentType<BridgeProps> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void import("./RealtimeBridge").then((module) => {
        if (!cancelled) setBridge(() => module.default);
      }, () => undefined);
    };
    const idle = typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(load, { timeout: 3_000 })
      : window.setTimeout(load, 1_000);
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, []);
  return Bridge ? <Bridge {...props} /> : null;
}
