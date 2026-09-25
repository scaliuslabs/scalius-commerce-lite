// Route permissions for the brand API. Brands are catalogue taxonomy beside
// categories, so they reuse the category permissions (no new role grants):
// whoever may manage categories may manage brands, and the product form's
// brand picker is open to product viewers as the category picker is.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const BRAND_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/brands": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    POST: { permission: PERMISSIONS.CATEGORIES_CREATE },
  },
  "/api/v1/admin/brands/form-options": {
    GET: { anyOf: [PERMISSIONS.CATEGORIES_VIEW, PERMISSIONS.PRODUCTS_VIEW] },
  },
  "/api/v1/admin/brands/trash": {
    POST: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/v1/admin/brands/restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
  },
  "/api/v1/admin/brands/delete-permanently": {
    POST: { permission: PERMISSIONS.CATEGORIES_PERMANENT_DELETE },
  },
  "/api/v1/admin/brands/*": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    PUT: { permission: PERMISSIONS.CATEGORIES_EDIT },
  },
  "/api/v1/admin/brands/*/status": {
    PATCH: { permission: PERMISSIONS.CATEGORIES_EDIT },
  },
};
