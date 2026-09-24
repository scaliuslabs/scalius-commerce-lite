// Route permissions for the product API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const PRODUCT_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Products API
  // =============================================
  "/api/v1/admin/products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_CREATE },
  },
  "/api/v1/admin/products/by-ids": {
    GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.COLLECTIONS_VIEW] },
  },
  "/api/v1/admin/products/bulk-delete": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
    DELETE: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
  },
  "/api/v1/admin/products/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_DELETE },
  },
  "/api/v1/admin/products/bulk-update": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
  },
  "/api/v1/admin/products/*/duplicate": {
    POST: { permission: PERMISSIONS.PRODUCTS_CREATE },
  },
  "/api/v1/admin/products/*/restore": {
    POST: { permission: PERMISSIONS.PRODUCTS_RESTORE },
  },
  "/api/v1/admin/products/*/permanent": {
    DELETE: { permission: PERMISSIONS.PRODUCTS_PERMANENT_DELETE },
  },
  "/api/v1/admin/products/*/variants": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/variants/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/options/matrix": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/products/*/sections/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
};
