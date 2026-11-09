// Maps admin API routes to the permissions they require. Each domain keeps its
// routes in its own file beside this one; this file merges them and resolves a
// request path to its rule.

import { AGENT_ACCESS_ROUTE_PERMISSIONS } from "./agent-access";
import { PRODUCT_ROUTE_PERMISSIONS } from "./products";
import { CATALOG_ROUTE_PERMISSIONS } from "./catalog";
import { ORDER_ROUTE_PERMISSIONS } from "./orders";
import { CUSTOMER_ROUTE_PERMISSIONS } from "./customers";
import { DISCOUNT_ROUTE_PERMISSIONS } from "./discounts";
import { CONTENT_ROUTE_PERMISSIONS } from "./content";
import { DASHBOARD_ROUTE_PERMISSIONS } from "./dashboard";
import { SETTINGS_ROUTE_PERMISSIONS } from "./settings";
import { INVENTORY_ROUTE_PERMISSIONS } from "./inventory";
import { STAFF_ROUTE_PERMISSIONS } from "./staff";
import { CONVERSATION_ROUTE_PERMISSIONS } from "./conversations";
import { BRAND_ROUTE_PERMISSIONS } from "./brands";
import { CATALOG_PROJECTION_ROUTE_PERMISSIONS } from "./catalog-projections";
import { MERCHANDISING_ROUTE_PERMISSIONS } from "./merchandising";
import { ATTRIBUTE_TYPED_ROUTE_PERMISSIONS } from "./attributes-typed";
import { REVIEW_ROUTE_PERMISSIONS } from "./reviews";
import { GIFT_CARD_ROUTE_PERMISSIONS } from "./gift-cards";
import { DIGITAL_ROUTE_PERMISSIONS } from "./digital";
import { WARRANTY_ROUTE_PERMISSIONS } from "./warranty";
import { WEBHOOK_ROUTE_PERMISSIONS } from "./webhooks";
import { CUSTOM_FIELD_ROUTE_PERMISSIONS } from "./custom-fields";
import { APP_ROUTE_PERMISSIONS } from "./apps";
import { STORE_TRANSFER_ROUTE_PERMISSIONS } from "./store-transfer";
import { OBJECT_ROUTE_PERMISSIONS } from "./objects";
import { RESOURCE_ROUTE_PERMISSIONS } from "./resources";
import { MethodNotAllowedError, NotFoundError } from "../../../errors";
import type { HttpMethod, RoutePermission, RoutePermissionMap } from "./shared";

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Every domain's route map. A path pattern belongs to exactly one map
 * (route-permissions.test.ts); the merged key order is the lookup tie-break
 * order, so append new maps rather than reordering.
 */
export const ROUTE_PERMISSION_MAPS: readonly RoutePermissionMap[] = [
  AGENT_ACCESS_ROUTE_PERMISSIONS,
  PRODUCT_ROUTE_PERMISSIONS,
  CATALOG_ROUTE_PERMISSIONS,
  ORDER_ROUTE_PERMISSIONS,
  CUSTOMER_ROUTE_PERMISSIONS,
  DISCOUNT_ROUTE_PERMISSIONS,
  CONTENT_ROUTE_PERMISSIONS,
  DASHBOARD_ROUTE_PERMISSIONS,
  SETTINGS_ROUTE_PERMISSIONS,
  INVENTORY_ROUTE_PERMISSIONS,
  STAFF_ROUTE_PERMISSIONS,
  CONVERSATION_ROUTE_PERMISSIONS,
  BRAND_ROUTE_PERMISSIONS,
  CATALOG_PROJECTION_ROUTE_PERMISSIONS,
  MERCHANDISING_ROUTE_PERMISSIONS,
  ATTRIBUTE_TYPED_ROUTE_PERMISSIONS,
  REVIEW_ROUTE_PERMISSIONS,
  GIFT_CARD_ROUTE_PERMISSIONS,
  DIGITAL_ROUTE_PERMISSIONS,
  WARRANTY_ROUTE_PERMISSIONS,
  WEBHOOK_ROUTE_PERMISSIONS,
  CUSTOM_FIELD_ROUTE_PERMISSIONS,
  APP_ROUTE_PERMISSIONS,
  STORE_TRANSFER_ROUTE_PERMISSIONS,
  OBJECT_ROUTE_PERMISSIONS,
  RESOURCE_ROUTE_PERMISSIONS,
];

/**
 * Route permission mapping
 * Keys are URL patterns (glob-like)
 * Values define required permissions per HTTP method
 */
export const ROUTE_PERMISSIONS: RoutePermissionMap = Object.assign({}, ...ROUTE_PERMISSION_MAPS);

interface WildcardRoute {
  readonly pattern: string;
  readonly regex: RegExp;
}

/**
 * The wildcard patterns, most specific first (more path segments, then fewer
 * wildcards; ties keep merged key order), each compiled once at module load
 * from the static route maps. A pattern without a wildcard only matches its
 * own path, which the exact lookup already answered, so the table holds
 * wildcards only.
 */
function buildWildcardRoutes(): readonly WildcardRoute[] {
  return Object.keys(ROUTE_PERMISSIONS)
    .filter((pattern) => pattern.includes("*"))
    .sort((a, b) => {
      // More specific patterns (with more path segments) should come first
      const aSegments = a.split("/").length;
      const bSegments = b.split("/").length;
      if (aSegments !== bSegments) return bSegments - aSegments;

      // Patterns with fewer wildcards should come before patterns with more
      const aWildcards = (a.match(/\*/g) || []).length;
      const bWildcards = (b.match(/\*/g) || []).length;
      return aWildcards - bWildcards;
    })
    .map((pattern) => ({ pattern, regex: compilePattern(pattern) }));
}

const WILDCARD_ROUTES = buildWildcardRoutes();

/**
 * Get the permission configuration for a route and method
 */
export function getRoutePermission(
  pathname: string,
  method: HttpMethod
): RoutePermission | null {
  const normalizedPathname = normalizePathname(pathname);

  // Try exact match first
  const exactMatch = ROUTE_PERMISSIONS[normalizedPathname];
  if (exactMatch && exactMatch[method]) {
    return exactMatch[method] || null;
  }

  // Then the wildcard patterns, most specific first
  for (const { pattern, regex } of WILDCARD_ROUTES) {
    if (regex.test(normalizedPathname)) {
      const config = ROUTE_PERMISSIONS[pattern];
      if (config && config[method]) {
        return config[method] ?? null;
      }
    }
  }

  return null;
}

/** The methods the dashboard API maps at this path, in a fixed order. */
export function getRouteMethods(pathname: string): HttpMethod[] {
  return HTTP_METHODS.filter((method) => getRoutePermission(pathname, method) !== null);
}

/**
 * The permission rule for a request, or the refusal for a request no rule
 * names: 405 with the methods the path takes (sent as Allow), or 404 for a
 * path the dashboard API does not have. Every admin lane (staff sessions,
 * agent connections, in-process apps) asks this before anything else, so a
 * wrong method is never reported as a permission problem.
 */
export function requireRoutePermission(pathname: string, method: string): RoutePermission {
  const upper = method.toUpperCase();
  const permission = (HTTP_METHODS as readonly string[]).includes(upper)
    ? getRoutePermission(pathname, upper as HttpMethod)
    : null;
  if (permission) return permission;
  const allow = getRouteMethods(pathname);
  if (allow.length > 0) throw new MethodNotAllowedError(allow);
  throw new NotFoundError("No dashboard API endpoint has this path");
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  let end = normalized.length;
  while (end > 1 && normalized[end - 1] === "/") end -= 1;
  return normalized.slice(0, end);
}

/**
 * Compiles a wildcard pattern: `*` is one path segment, `**` one or more (only
 * plugin route families use it, whose sub-paths belong to the plugin).
 */
function compilePattern(pattern: string): RegExp {
  // Escape special regex chars (including backslash) before converting globs
  const regexPattern = pattern
    .replace(/[\\^$.|?+()[\]{}]/g, "\\$&") // Escape regex special chars
    .replace(/\*\*/g, "\uE000") // ** (one or more segments), expanded below
    .replace(/\*/g, "[^/]+") // * matches anything except /
    .replace(/\uE000/g, "[^/]+(?:/[^/]+)*")
    .replace(/\//g, "\\/"); // Escape forward slashes

  return new RegExp(`^${regexPattern}$`);
}
