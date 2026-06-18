import { useEffect } from "react";
import { createRouter, Link } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { createAdminQueryClient } from "./lib/admin-query-client";
import {
  isRecoverableRouteLoadError,
  recoverableRouteErrorSignature,
  RECOVERABLE_ROUTE_RELOAD_KEY,
} from "./lib/recoverable-route-error";

function DefaultPendingComponent() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

function DefaultNotFoundComponent() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground">
      <div className="w-full max-w-sm text-center space-y-4">
        <p className="text-6xl font-bold text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold">Page Not Found</h1>
        <p className="text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link
          to="/admin"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}

function DefaultErrorComponent({ error }: { error: Error }) {
  const recoverableLoadError = isRecoverableRouteLoadError(error);

  useEffect(() => {
    if (!recoverableLoadError) return;

    const signature = `${window.location.pathname}:${recoverableRouteErrorSignature(error)}`;
    const previousSignature = window.sessionStorage.getItem(
      RECOVERABLE_ROUTE_RELOAD_KEY,
    );

    if (previousSignature !== signature) {
      window.sessionStorage.setItem(RECOVERABLE_ROUTE_RELOAD_KEY, signature);
      window.location.reload();
    }
  }, [error, recoverableLoadError]);

  const handleReload = () => {
    window.sessionStorage.removeItem(RECOVERABLE_ROUTE_RELOAD_KEY);
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-background text-foreground">
      <div className="w-full max-w-sm text-center space-y-4">
        <p className="text-6xl font-bold text-muted-foreground">500</p>
        <h1 className="text-xl font-semibold">
          {recoverableLoadError ? "Update Needed" : "Something Went Wrong"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {recoverableLoadError
            ? "The dashboard was updated while this tab was open. Reload to continue."
            : "An unexpected error occurred. Please try again or contact support if the problem persists."}
        </p>
        {import.meta.env.DEV && error?.message && (
          <pre className="mt-4 rounded-md bg-muted p-3 text-left text-xs text-muted-foreground overflow-auto max-h-40">
            {error.message}
          </pre>
        )}
        {recoverableLoadError ? (
          <button
            type="button"
            onClick={handleReload}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Reload
          </button>
        ) : (
          <Link
            to="/admin"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Back to Dashboard
          </Link>
        )}
      </div>
    </div>
  );
}

export function getRouter() {
  const queryClient = createAdminQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    scrollToTopSelectors: ["#admin-main-scroll"],
    scrollRestorationBehavior: "instant",
    defaultPreload: false,
    defaultPendingMs: 200,
    defaultPendingMinMs: 300,
    defaultPendingComponent: DefaultPendingComponent,
    defaultNotFoundComponent: DefaultNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
  });

  // SSR dehydration/hydration for React Query — handles streaming automatically
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
