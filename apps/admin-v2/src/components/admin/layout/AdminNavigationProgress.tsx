import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";

export const ADMIN_NAVIGATION_PROGRESS_DELAY_MS = 180;
export const ADMIN_NAVIGATION_PROGRESS_MIN_VISIBLE_MS = 160;

function useDelayedNavigationProgress(active: boolean) {
  const [visible, setVisible] = useState(false);
  const visibleSinceRef = useRef(0);

  useEffect(() => {
    if (active) {
      if (visible) return;

      const showTimer = window.setTimeout(() => {
        visibleSinceRef.current = Date.now();
        setVisible(true);
      }, ADMIN_NAVIGATION_PROGRESS_DELAY_MS);

      return () => window.clearTimeout(showTimer);
    }

    if (!visible) return;

    const visibleFor = Date.now() - visibleSinceRef.current;
    const remainingVisibleTime = Math.max(
      0,
      ADMIN_NAVIGATION_PROGRESS_MIN_VISIBLE_MS - visibleFor,
    );
    const hideTimer = window.setTimeout(
      () => setVisible(false),
      remainingVisibleTime,
    );

    return () => window.clearTimeout(hideTimer);
  }, [active, visible]);

  return visible;
}

export function AdminNavigationProgressView({ active }: { active: boolean }) {
  const visible = useDelayedNavigationProgress(active);

  return (
    <>
      {visible ? (
        <div
          data-admin-navigation-progress=""
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-primary/15"
        >
          <div className="h-full w-full animate-pulse bg-gradient-to-r from-primary/35 via-primary to-primary/35 motion-reduce:animate-none" />
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {visible ? "Loading next page" : ""}
      </span>
    </>
  );
}

export function AdminNavigationProgress() {
  const isNavigating = useRouterState({
    select: (state) => state.isLoading,
  });

  return <AdminNavigationProgressView active={isNavigating} />;
}
