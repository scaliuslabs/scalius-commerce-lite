/**
 * Loads the realtime bridge a moment after the first page has rendered: the
 * live connection is never part of a screen's first download.
 */
import { useEffect, useState, type ComponentType } from "react";

type BridgeProps = { userId: string; permissions: readonly string[] };

export function RealtimeLoader(props: BridgeProps) {
  const [Bridge, setBridge] = useState<ComponentType<BridgeProps> | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => void import("./RealtimeBridge").then((module) => setBridge(() => module.default), () => undefined), 1_500);
    return () => clearTimeout(timer);
  }, []);
  return Bridge ? <Bridge {...props} /> : null;
}
