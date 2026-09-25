// Route permissions for the discount API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const DISCOUNT_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Discounts API (SENSITIVE)
  // =============================================
  "/api/v1/admin/discounts": {
    GET: { permission: PERMISSIONS.DISCOUNTS_VIEW },
    POST: { permission: PERMISSIONS.DISCOUNTS_CREATE },
  },
  "/api/v1/admin/discounts/*/preview": {
    POST: { permission: PERMISSIONS.DISCOUNTS_VIEW },
  },
  "/api/v1/admin/discounts/*/activate": {
    POST: { permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS },
  },
  "/api/v1/admin/discounts/*/pause": {
    POST: { permission: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS },
  },
  "/api/v1/admin/discounts/*": {
    GET: { permission: PERMISSIONS.DISCOUNTS_VIEW },
    PUT: { permission: PERMISSIONS.DISCOUNTS_EDIT },
    DELETE: { permission: PERMISSIONS.DISCOUNTS_DELETE },
  },
};
