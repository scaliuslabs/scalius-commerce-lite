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
import type { HttpMethod, RoutePermission, RoutePermissionMap } from "./shared";

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
];

/**
 * Route permission mapping
 * Keys are URL patterns (glob-like)
 * Values define required permissions per HTTP method
 */
export const ROUTE_PERMISSIONS: RoutePermissionMap = Object.assign({}, ...ROUTE_PERMISSION_MAPS);

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

  // Try pattern matching with wildcards
  // Sort patterns by specificity (longer patterns first, patterns with more specific segments first)
  const sortedPatterns = Object.keys(ROUTE_PERMISSIONS).sort((a, b) => {
    // More specific patterns (with more path segments) should come first
    const aSegments = a.split("/").length;
    const bSegments = b.split("/").length;
    if (aSegments !== bSegments) return bSegments - aSegments;

    // Patterns without wildcards should come before patterns with wildcards
    const aWildcards = (a.match(/\*/g) || []).length;
    const bWildcards = (b.match(/\*/g) || []).length;
    return aWildcards - bWildcards;
  });

  for (const pattern of sortedPatterns) {
    if (matchPattern(pattern, normalizedPathname)) {
      const config = ROUTE_PERMISSIONS[pattern];
      if (config && config[method]) {
        return config[method] ?? null;
      }
    }
  }

  return null;
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  let end = normalized.length;
  while (end > 1 && normalized[end - 1] === "/") end -= 1;
  return normalized.slice(0, end);
}

/**
 * Simple pattern matching with * wildcard
 */
function matchPattern(pattern: string, pathname: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === pathname;
  }

  // Convert glob pattern to regex
  // Escape special regex chars (including backslash) before converting globs
  const regexPattern = pattern
    .replace(/[\\^$.|?+()[\]{}]/g, "\\$&") // Escape regex special chars
    .replace(/\*/g, "[^/]+") // * matches anything except /
    .replace(/\//g, "\\/"); // Escape forward slashes

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(pathname);
}
