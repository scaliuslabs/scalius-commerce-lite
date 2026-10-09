// Route discovery for the dashboard quality harness (pure: no browser, no network).
// The list comes from the generated route tree, so a new screen is audited
// without a list to edit (apps/admin-v2/src/routeTree.gen.ts, `FileRoutesByTo`:
// one key per URL a person can open).
import { globMatch } from "../quality-shared/page-checks.mjs";

/** Leaf URLs of the route tree, in file order. */
export function parseLeafRoutes(source) {
  const block = source.match(/export interface FileRoutesByTo \{([\s\S]*?)\n\}/);
  if (!block) throw new Error("routeTree.gen.ts has no FileRoutesByTo interface (did the router plugin change?).");
  const paths = [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]);
  return [...new Set(paths)];
}

export const paramNames = (path) => [...path.matchAll(/\$([A-Za-z0-9_]+)/g)].map((match) => match[1]);

export function fillPath(path, values) {
  return path.replace(/\$([A-Za-z0-9_]+)/g, (_, name) => encodeURIComponent(values[name]));
}

/** `/admin/products/$productId/edit` is in family "products"; `/admin` is "home". */
export function familyOf(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "admin") return parts[1] ?? "home";
  if (parts[0] === "auth") return "auth";
  return "public";
}

/** Pages that cannot be opened by URL alone, each with the reason it is left out. */
export const SKIPPED_ROUTES = [
  { match: "/auth/reset-password", reason: "needs an emailed reset token" },
  { match: "/auth/two-factor", reason: "needs a half-signed-in session" },
  { match: "/auth/setup-2fa", reason: "needs a half-signed-in session" },
  { match: "/auth/setup", reason: "first-run setup answers only before an admin exists" },
  { match: "/admin/settings/agent-access/*", reason: "needs a live agent-access request or handoff id" },
  { match: "/admin/apps/$pluginId/pages/$pageId", reason: "needs an app that declares a page" },
  { match: "/scanner", reason: "standalone phone scanner app with its own QR sign-in" },
  { match: "/connect", reason: "needs an OAuth consent request" },
];

export function skipReason(path) {
  const hit = SKIPPED_ROUTES.find((item) => globMatch(item.match, path));
  return hit ? hit.reason : null;
}

/** Pages that must be opened signed out. */
export const isPublicAuthRoute = (path) => path.startsWith("/auth/");

const toPatterns = (list) => list.map((item) => item.trim()).filter(Boolean);

/**
 * `--routes` items match a route path as a glob (`/admin/products*`), or as a
 * plain part of the path (`products`). `--family` is a family name.
 */
export function filterRoutes(paths, { routes = [], families = [] } = {}) {
  const patterns = toPatterns(routes);
  const wanted = new Set(toPatterns(families));
  return paths.filter((path) => {
    if (wanted.size && !wanted.has(familyOf(path))) return false;
    if (!patterns.length) return true;
    return patterns.some((pattern) => (pattern.includes("*") ? globMatch(pattern, path) : path.includes(pattern)));
  });
}

/**
 * The runs of one audit: a route (with its params filled), a width and a
 * locale. `resolved` maps a param name to its value; a route whose param has
 * none is returned in `skipped` with the reason.
 */
export function buildPlan({ paths, resolved, unresolved = {} }) {
  const routes = [];
  const skipped = [];
  for (const path of paths) {
    const reason = skipReason(path);
    if (reason) {
      skipped.push({ path, reason });
      continue;
    }
    const missing = paramNames(path).filter((name) => !resolved[name]);
    if (missing.length) {
      skipped.push({ path, reason: unresolved[missing[0]] ?? `no value for :${missing[0]}` });
      continue;
    }
    routes.push({ path, url: fillPath(path, resolved), family: familyOf(path), public: isPublicAuthRoute(path) });
  }
  return { routes, skipped };
}

/**
 * The page URL: the dashboard base URL gives the origin and any deployment
 * prefix before `/admin` (a base of http://host/admin has none).
 */
export function pageUrl(baseUrl, routeUrl) {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/admin\/?$/, "").replace(/\/$/, "");
  return `${base.origin}${prefix}${routeUrl}`;
}

export function parseList(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
