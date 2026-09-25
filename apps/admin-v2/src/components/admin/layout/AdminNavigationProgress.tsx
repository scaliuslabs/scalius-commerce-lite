import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

/** A navigation faster than this shows no bar at all. */
export const ADMIN_NAVIGATION_PROGRESS_DELAY_MS = 180;
/** The finish: the bar runs to the end, then fades (global.css). */
export const ADMIN_NAVIGATION_PROGRESS_FINISH_MS = 400;

type ProgressState = "hidden" | "loading" | "done";

function useNavigationProgressState(active: boolean): ProgressState {
  const [state, setState] = useState<ProgressState>("hidden");

  useEffect(() => {
    if (active) {
      if (state === "loading") return;
      // A new navigation during the finish starts the bar again at once.
      const timer = window.setTimeout(() => setState("loading"), state === "done" ? 0 : ADMIN_NAVIGATION_PROGRESS_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (state === "loading") {
      setState("done");
      return;
    }
    if (state === "done") {
      const timer = window.setTimeout(() => setState("hidden"), ADMIN_NAVIGATION_PROGRESS_FINISH_MS);
      return () => window.clearTimeout(timer);
    }
  }, [active, state]);

  return state;
}

/**
 * Shopify's page-loading bar: 3px across the top of the canvas (clipped by its corners) in the
 * accent colour, a quick start that slows as it nears the end, and a smooth
 * run to 100% and fade once the page is ready. Fast navigations show nothing.
 */
export function AdminNavigationProgressView({ active }: { active: boolean }) {
  const t = useMessages(shellMessages);
  const state = useNavigationProgressState(active);

  return (
    <>
      {state === "hidden" ? null : (
        <div
          data-admin-navigation-progress=""
          data-state={state}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px]"
        >
          <div className="h-full w-full bg-topbar-progress" />
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {state === "loading" ? t("loadingNextPage") : ""}
      </span>
    </>
  );
}

export function AdminNavigationProgress() {
  const isNavigating = useRouterState({ select: (state) => state.isLoading });
  return <AdminNavigationProgressView active={isNavigating} />;
}
