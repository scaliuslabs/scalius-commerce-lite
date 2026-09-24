// Route permissions for the inventory API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const INVENTORY_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Inventory API
  // =============================================
  "/api/v1/admin/inventory": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/labels/preview": {
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/labels/artifact": {
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/movements/export": {
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/alerts": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/scanner/lookup": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/stock-adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/stock-set": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/default-alert-level": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/alert-level": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
};
