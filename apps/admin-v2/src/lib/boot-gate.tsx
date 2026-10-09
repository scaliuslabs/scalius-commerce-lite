import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { BootSpinner } from "~/components/admin/states/PageSkeleton";

/**
 * Keeps index.html's boot spinner until the router commits its first page,
 * so the dashboard mounts at once (and can paint a page's skeleton while its
 * data loads) without ever showing an empty frame before the session guard.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const started = useRouterState({ select: (state) => state.matches.length > 0 });
  return (
    <>
      {children}
      {started ? null : <BootSpinner />}
    </>
  );
}
