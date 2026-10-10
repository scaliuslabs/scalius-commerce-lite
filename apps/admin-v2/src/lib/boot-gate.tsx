import { useEffect, type JSX, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { BootSpinner } from "~/components/admin/states/PageSkeleton";
import { preloadRouteStateViews } from "./route-error";

/**
 * Keeps index.html's boot spinner until the router commits its first page,
 * so the dashboard mounts at once (and can paint a page's skeleton while its
 * data loads) without ever showing an empty frame before the session guard.
 * Once the first page is up and the browser is idle, the error and not-found
 * views download, so they are in the tab before any connection drops.
 */
export function BootGate({ children }: { children: ReactNode }): JSX.Element {
  const started = useRouterState({ select: (state) => state.matches.length > 0 });
  useEffect(() => {
    if (!started || navigator.onLine === false) return;
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(preloadRouteStateViews, { timeout: 3_000 });
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(preloadRouteStateViews, 1_000);
    return () => window.clearTimeout(timer);
  }, [started]);
  return (
    <>
      {children}
      {started ? null : <BootSpinner />}
    </>
  );
}
