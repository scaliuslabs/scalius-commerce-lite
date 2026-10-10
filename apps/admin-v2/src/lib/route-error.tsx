/**
 * The router's error, not-found and pending views. The failed-read view and
 * the page skeleton ship with the router, so a page that fails or loads
 * offline never needs a download first. The missing-record and no-access
 * views (record nouns, the store owner's name) load lazily and are preloaded
 * once the first page is up (`preloadRouteStateViews`).
 */
import { lazy, Suspense, useEffect, type JSX, type ReactNode } from "react";
import { useMatch, useRouter } from "@tanstack/react-router";
import { ErrorState } from "~/components/admin/states/ErrorState";
import { classifyFailure } from "~/components/admin/states/failure";
import { BootSpinner, PageSkeleton, type PageSkeletonKind } from "~/components/admin/states/PageSkeleton";
import { titleFromHead } from "~/i18n/page-titles";
import { reloadRecoverableRouteOnce } from "./recoverable-route-error";

const loadMissingViews = () => import("./route-not-found");
const LazyMissingView = lazy(() => loadMissingViews().then((module) => ({ default: module.MissingView })));
const LazyNotFound = lazy(() => loadMissingViews().then((module) => ({ default: module.RouteNotFoundComponent })));

/** Fetches the not-found and no-access views ahead of need; a failure only means they load when first shown. */
export function preloadRouteStateViews(): void {
  void loadMissingViews().catch(() => undefined);
}

function FullPage({ children }: { children: ReactNode }) {
  return <main className="min-h-dvh bg-background px-3 py-12 text-foreground sm:px-4 md:px-6"><div className="mx-auto max-w-2xl">{children}</div></main>;
}

export function RouteErrorComponent({
  error,
  reset,
  fullPage = false,
}: {
  error: Error;
  reset: () => void;
  fullPage?: boolean;
}): JSX.Element {
  const router = useRouter();
  const pageTitle = useMatch({ strict: false, select: (match) => titleFromHead(match.meta) });
  const kind = classifyFailure(error);

  useEffect(() => {
    // A deploy replaced the bundle this tab was using: reload once by itself.
    // Never offline: a reload then is the browser's blank error page.
    if (kind !== "updated") return;
    reloadRecoverableRouteOnce({
      error,
      pathname: window.location.pathname,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
  }, [error, kind]);

  if (kind === "notFound" || kind === "forbidden") {
    return (
      <Suspense fallback={null}>
        <LazyMissingView kind={kind} fullPage={fullPage} />
      </Suspense>
    );
  }

  const retry = () => {
    reset();
    void router.invalidate();
  };
  const view = <ErrorState error={error} kind={kind} layout="page" pageTitle={pageTitle || undefined} onRetry={retry} />;
  return fullPage ? <FullPage>{view}</FullPage> : view;
}

export function RouteNotFoundComponent(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyNotFound />
    </Suspense>
  );
}

/** Which skeleton a route shows while its loader runs; null for the shell itself and standalone pages. */
export function pendingKindForPath(fullPath: string): PageSkeletonKind | null {
  if (!fullPath.startsWith("/admin/")) return null;
  if (fullPath.startsWith("/admin/settings")) return "settings";
  return fullPath.includes("$") ? "detail" : "page";
}

/**
 * Pages opened most from links (a push, an email, a list) draw their own
 * card layout: rows per card, main column then side column. Kept here, not
 * in the route files, so no route's pending view becomes a chunk of its own
 * that a cold or offline load would first have to download.
 */
const PAGE_SHAPES: Record<string, { main: number[]; side: number[] }> = {
  "/admin/orders/$orderId/": { main: [4, 3, 2], side: [3, 2, 2] },
  "/admin/products/$productId/edit": { main: [3, 1, 2, 3], side: [2, 2, 2] },
  "/admin/customers/$customerId/edit": { main: [3, 3], side: [2, 2] },
};

/**
 * A route still loading after `defaultPendingMs` shows its page's shape
 * inside the shell (polish bar L1); the shell's own guard and standalone
 * pages show the quiet boot spinner.
 */
export function RoutePendingComponent(): JSX.Element {
  const fullPath = useMatch({ strict: false, select: (match): string => match.fullPath });
  const kind = pendingKindForPath(fullPath);
  if (!kind) return <BootSpinner />;
  return <PageSkeleton kind={kind} {...PAGE_SHAPES[fullPath]} />;
}
