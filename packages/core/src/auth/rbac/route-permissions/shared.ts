// Types shared by the per-domain route permission maps.

import { PERMISSIONS } from "../permissions";
import type { PermissionName } from "../types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RoutePermission {
  // Single permission required
  permission?: PermissionName;
  // Any of these permissions is sufficient
  anyOf?: PermissionName[];
  // All of these permissions are required
  allOf?: PermissionName[];
  // Any authenticated user with at least one admin permission is allowed.
  allowAnyAdmin?: boolean;
}

export type RouteConfig = {
  [method in HttpMethod]?: RoutePermission;
};

/**
 * Any staff member or agent connection with at least one permission. Unlike
 * `allowAnyAdmin` (the signed-in person's own account), agent connections with
 * a scoped grant keep these reads.
 */
export const ANY_STAFF: PermissionName[] = Object.values(PERMISSIONS);

/** Keys are URL patterns (glob-like); values define required permissions per HTTP method. */
export type RoutePermissionMap = Record<string, RouteConfig>;
