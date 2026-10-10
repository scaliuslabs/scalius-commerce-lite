/**
 * The router's missing-record, missing-page and no-access views. They load
 * lazily (they name records, read the store owner's name and carry the noun
 * catalog) and `preloadRouteStateViews` fetches them once the first page is up.
 */
import type { JSX } from "react";
import { rootRouteId, useMatch } from "@tanstack/react-router";
import { NoPermissionState, PageNotFound, RecordNotFound } from "~/components/admin/states/NotFound";
import { recordResource } from "~/components/admin/states/record-resource";

/** No route matched, or a loader threw `notFound()`: name the record when the route shows one. */
export function RouteNotFoundComponent(): JSX.Element {
  const fullPath = useMatch({ strict: false, select: (match) => (match.routeId === rootRouteId ? null : match.fullPath) });
  if (fullPath === null) return <PageNotFound fullPage />;
  return recordResource(fullPath) ? <RecordNotFound /> : <PageNotFound />;
}

/** A read answered 404 or 403: the record is gone, or not this person's to see. */
export function MissingView({ kind, fullPage }: { kind: "notFound" | "forbidden"; fullPage: boolean }): JSX.Element {
  if (kind === "forbidden") return <NoPermissionState fullPage={fullPage} />;
  return fullPage ? <PageNotFound fullPage /> : <RecordNotFound />;
}
