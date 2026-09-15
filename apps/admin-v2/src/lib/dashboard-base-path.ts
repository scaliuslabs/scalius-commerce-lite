/**
 * Runtime dashboard base path.
 *
 * The dashboard may be served below a path prefix (Settings -> System ->
 * Platform, Dashboard URL `https://shop.example.com/dashboard`). The prefix is
 * a runtime setting, never a build constant, so:
 *
 *   - on the server it is read from the request-scoped runtime env;
 *   - in the browser it is read from the `<meta>` tag the root route renders,
 *     which exists before any client script runs.
 *
 * Every same-origin URL the dashboard builds itself (router base path, API
 * proxy calls, Better Auth routes, server-function calls, static assets,
 * service worker registration, full-page redirects) goes through
 * `withDashboardBasePath`. At a host root the base path is "" and every
 * helper is an identity function.
 */
import { createIsomorphicFn } from "@tanstack/react-start";
import {
  dashboardBasePathFromUrl,
  normalizeDashboardBasePath,
  prefixDashboardBasePath,
} from "@scalius/shared/platform-config";

import { getRuntimeEnv } from "./runtime-env.server";

export { prefixDashboardBasePath, stripDashboardBasePath } from "@scalius/shared/platform-config";

export const DASHBOARD_BASE_PATH_META_NAME = "scalius-dashboard-base-path";

let clientBasePath: string | null = null;

/** Browser reading: the meta tag rendered by the root route, memoized per document. */
export function readDashboardBasePathFromDocument(): string {
  if (clientBasePath !== null) return clientBasePath;
  if (typeof document === "undefined") return "";
  const content = document
    .querySelector(`meta[name="${DASHBOARD_BASE_PATH_META_NAME}"]`)
    ?.getAttribute("content");
  clientBasePath = normalizeDashboardBasePath(content ?? "") ?? "";
  return clientBasePath;
}

/** "" at a host root, otherwise "/prefix" without a trailing slash. */
export const getDashboardBasePath: () => string = createIsomorphicFn()
  .server(() => dashboardBasePathFromUrl(getRuntimeEnv().PLATFORM_CONFIG?.dashboardUrl))
  .client(readDashboardBasePathFromDocument);

/** Test seam for the browser reading; production code never calls this. */
export function resetDashboardBasePathCache(): void {
  clientBasePath = null;
}

export function withDashboardBasePath(path: string): string {
  return prefixDashboardBasePath(getDashboardBasePath(), path);
}
