// Types shared by the per-domain route permission maps.

import { PERMISSIONS } from "../permissions";
import { TRANSLATION_TYPE_PERMISSIONS } from "../translation-permissions";
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

/**
 * Viewing any translatable resource (Translate & adapt opens for each): the
 * handler checks the resource type's own permission. The store's languages and
 * markets are read with them, since translating names a language and adapting
 * a market.
 */
export const TRANSLATION_VIEW: PermissionName[] = [
  ...new Set(Object.values(TRANSLATION_TYPE_PERMISSIONS).map((permissions) => permissions.view)),
];
