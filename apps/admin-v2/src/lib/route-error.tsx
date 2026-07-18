/**
 * Shared error component for route-level error boundaries.
 *
 * Kept separate from list/search helpers so simple routes do not pull Zod into
 * their route module graph just to render an error boundary.
 */
import { useEffect } from "react";

import {
  isRecoverableRouteLoadError,
  reloadRecoverableRouteOnce,
  RECOVERABLE_ROUTE_RELOAD_KEY,
} from "./recoverable-route-error";

export function RouteErrorComponent({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const recoverableLoadError = isRecoverableRouteLoadError(error);

  useEffect(() => {
    if (!recoverableLoadError) return;
    reloadRecoverableRouteOnce({
      error,
      pathname: window.location.pathname,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
  }, [error, recoverableLoadError]);

  const recover = () => {
    if (recoverableLoadError) {
      window.sessionStorage.removeItem(RECOVERABLE_ROUTE_RELOAD_KEY);
      window.location.reload();
      return;
    }
    reset();
  };

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-4xl font-bold text-muted-foreground mb-2">
        {recoverableLoadError ? "Update needed" : "Error"}
      </p>
      <p className="text-sm text-muted-foreground mb-4">
        {recoverableLoadError
          ? "The dashboard was updated while this tab was open. Reloading keeps you on this page."
          : error instanceof Error
            ? error.message
            : "Something went wrong loading this page."}
      </p>
      <button
        onClick={recover}
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        {recoverableLoadError ? "Reload" : "Try Again"}
      </button>
    </div>
  );
}
