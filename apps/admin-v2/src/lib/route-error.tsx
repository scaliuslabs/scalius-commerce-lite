/**
 * The router's error, not-found and pending views. Pending (a page's
 * skeleton) is in the first download; the error and not-found views load
 * lazily and are preloaded once the first page is up (`preloadRouteStateViews`),
 * so an offline or failing page still has them.
 */
import { lazy, Suspense, type JSX } from "react";
import { useMatch, type ErrorComponentProps } from "@tanstack/react-router";
import { BootSpinner, PageSkeleton, type PageSkeletonKind } from "~/components/admin/states/PageSkeleton";

const loadViews = () => import("./route-error-views");
const ErrorView = lazy(() => loadViews().then((module) => ({ default: module.RouteErrorComponent })));
const NotFoundView = lazy(() => loadViews().then((module) => ({ default: module.RouteNotFoundComponent })));

/** Fetches the error and not-found views ahead of need; a failure only means they load when first shown. */
export function preloadRouteStateViews(): void {
  void loadViews().catch(() => undefined);
}

export function RouteErrorComponent(props: Pick<ErrorComponentProps, "error" | "reset"> & { fullPage?: boolean }): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ErrorView {...props} />
    </Suspense>
  );
}

export function RouteNotFoundComponent(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <NotFoundView />
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
