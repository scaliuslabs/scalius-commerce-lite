// Route permissions for the typed-attribute API (migration 0090): spec groups,
// the id-based value vocabulary, value-type conversion and category attribute
// sets, all under /api/v1/admin/attributes. They reuse the attribute
// permissions (no new role grants).
//
// Group items (`groups/{groupId}`) and category sets (`category-sets/{id}`)
// share the two-wildcard `attributes/*/*` rule: a one-wildcard pattern such as
// `attributes/groups/*` would tie with catalog.ts's `attributes/*/values` and
// friends, which this map must never need the merge order to resolve.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const ATTRIBUTE_TYPED_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/attributes/groups": {
    // The product form groups the specs it shows.
    GET: { anyOf: [PERMISSIONS.ATTRIBUTES_VIEW, PERMISSIONS.PRODUCTS_VIEW] },
    POST: { permission: PERMISSIONS.ATTRIBUTES_CREATE },
  },
  "/api/v1/admin/attributes/groups/order": {
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/*/*": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PATCH: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/*/normalized-values": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/*/normalized-values/order": {
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/*/normalized-values/*": {
    PATCH: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/*/convert-type": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
};
