/**
 * Runtime dashboard base path.
 *
 * The dashboard may be served below a path prefix (Settings -> System ->
 * Platform, Dashboard URL `https://shop.example.com/dashboard`). The prefix is
 * a runtime setting, never a build constant: the API Worker writes it into the
 * shell's `<meta>` tag (apps/api/src/dashboard/surface.ts) before any script
 * runs, and `vite dev` always serves at the host root.
 *
 * Every same-origin URL the dashboard builds itself (router base path, API
 * calls, Better Auth routes, service worker registration, full-page
 * redirects) goes through `withDashboardBasePath`. At a host root the base
 * path is "" and every helper is an identity function.
 */
import {
  normalizeDashboardBasePath,
  prefixDashboardBasePath,
} from "@scalius/shared/platform-config";

export { prefixDashboardBasePath, stripDashboardBasePath } from "@scalius/shared/platform-config";

export const DASHBOARD_BASE_PATH_META_NAME = "scalius-dashboard-base-path";

let cachedBasePath: string | null = null;

/** "" at a host root, otherwise "/prefix" without a trailing slash. */
export function getDashboardBasePath(): string {
  if (cachedBasePath !== null) return cachedBasePath;
  if (typeof document === "undefined") return "";
  const content = document
    .querySelector(`meta[name="${DASHBOARD_BASE_PATH_META_NAME}"]`)
    ?.getAttribute("content");
  cachedBasePath = normalizeDashboardBasePath(content ?? "") ?? "";
  return cachedBasePath;
}

/** Test seam; production code never calls this. */
export function resetDashboardBasePathCache(): void {
  cachedBasePath = null;
}

export function withDashboardBasePath(path: string): string {
  return prefixDashboardBasePath(getDashboardBasePath(), path);
}
