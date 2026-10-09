/**
 * The router's error, not-found and pending views, built from the one state
 * family (components/admin/states). Route boundaries render them inside the
 * admin shell; the router's defaults render them full page when the root, or
 * the shell's own session guard, is what failed.
 */
import { useEffect, type JSX, type ReactNode } from "react";
import { rootRouteId, useMatch, useRouter } from "@tanstack/react-router";
import { BootSpinner, PageSkeleton, type PageSkeletonKind } from "~/components/admin/states/PageSkeleton";
import { ErrorState } from "~/components/admin/states/ErrorState";
import { NoPermissionState, PageNotFound, RecordNotFound } from "~/components/admin/states/NotFound";
import { classifyFailure } from "~/components/admin/states/failure";
import { recordResource } from "~/components/admin/states/record-resource";
import { titleFromHead } from "~/i18n/page-titles";
import { reloadRecoverableRouteOnce } from "./recoverable-route-error";

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

  if (kind === "notFound") return fullPage ? <PageNotFound fullPage /> : <RecordNotFound />;
  if (kind === "forbidden") return <NoPermissionState fullPage={fullPage} />;

  const retry = () => {
    reset();
    void router.invalidate();
  };
  const view = <ErrorState error={error} kind={kind} layout="page" pageTitle={pageTitle || undefined} onRetry={retry} />;
  return fullPage ? <FullPage>{view}</FullPage> : view;
}

/** No route matched, or a loader threw `notFound()`: name the record when the route shows one. */
export function RouteNotFoundComponent(): JSX.Element {
  const fullPath = useMatch({ strict: false, select: (match) => (match.routeId === rootRouteId ? null : match.fullPath) });
  if (fullPath === null) return <PageNotFound fullPage />;
  return recordResource(fullPath) ? <RecordNotFound /> : <PageNotFound />;
}

/** Which skeleton a route shows while its loader runs. */
export function pendingKindForPath(fullPath: string): PageSkeletonKind | null {
  if (!fullPath.startsWith("/admin")) return null;
  if (fullPath.startsWith("/admin/settings")) return "settings";
  return fullPath.includes("$") ? "detail" : "page";
}

/**
 * A route still loading after `defaultPendingMs` shows its page's shape
 * inside the shell (polish bar L1); a standalone page shows the quiet boot
 * spinner.
 */
export function RoutePendingComponent(): JSX.Element {
  const fullPath = useMatch({ strict: false, select: (match): string => match.fullPath });
  const kind = pendingKindForPath(fullPath);
  return kind ? <PageSkeleton kind={kind} /> : <BootSpinner />;
}
