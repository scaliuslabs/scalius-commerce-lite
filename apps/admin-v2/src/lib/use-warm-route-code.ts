import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/**
 * Warms the code of the screens this person may open, once the first page
 * has settled (`warm-route-code.ts`). The list itself loads then too: it is
 * never part of a page's first download.
 */

/** After the first page, a moment's quiet: never competes with its own reads. */
export const ROUTE_CODE_WARM_DELAY_MS = 2_000;

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** Data Saver or a 2G connection: pages fetch their code only when opened. */
export function shouldSkipRouteCodeWarming(connection: NetworkInformationLike | undefined): boolean {
  return Boolean(connection?.saveData) || connection?.effectiveType === "2g" || connection?.effectiveType === "slow-2g";
}

export function useWarmEverydayRouteCode(canOpen: (path: string) => boolean): void {
  const router = useRouter();
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    if (shouldSkipRouteCodeWarming(connection)) return;
    let idle: number | undefined;
    // Offline a failed download would stay failed until a reload: warm only online.
    const warm = () => {
      if (navigator.onLine !== false) void import("./warm-route-code").then(({ warmEverydayRouteCode }) => warmEverydayRouteCode(router, canOpen), () => {});
    };
    const timer = window.setTimeout(() => {
      // Wait for the browser to be idle too, where it can say (Safari cannot).
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(warm, { timeout: 5_000 });
      else warm();
    }, ROUTE_CODE_WARM_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [router, canOpen]);
}
