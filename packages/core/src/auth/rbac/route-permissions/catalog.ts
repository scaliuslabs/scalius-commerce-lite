// Route permissions for the category, collection and attribute API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const CATALOG_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Categories API
  // =============================================
  "/api/v1/admin/categories": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    POST: { permission: PERMISSIONS.CATEGORIES_CREATE },
  },
  "/api/v1/admin/categories/form-options": {
    GET: {
      anyOf: [
        PERMISSIONS.CATEGORIES_VIEW,
        PERMISSIONS.PRODUCTS_VIEW,
        PERMISSIONS.SETTINGS_GENERAL_VIEW,
        PERMISSIONS.SETTINGS_HEADER_EDIT,
      ],
    },
  },
  "/api/v1/admin/categories/bulk-delete": {
    POST: { permission: PERMISSIONS.CATEGORIES_DELETE },
    DELETE: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/v1/admin/categories/bulk-restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
  },
  "/api/v1/admin/categories/*/publish-readiness": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
  },
  "/api/v1/admin/categories/*/status": {
    PATCH: { permission: PERMISSIONS.CATEGORIES_EDIT },
  },
  "/api/v1/admin/categories/*/sections/*": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
  },
  "/api/v1/admin/categories/*": {
    GET: { permission: PERMISSIONS.CATEGORIES_VIEW },
    PUT: { permission: PERMISSIONS.CATEGORIES_EDIT },
    PATCH: { permission: PERMISSIONS.CATEGORIES_EDIT },
    DELETE: { permission: PERMISSIONS.CATEGORIES_DELETE },
  },
  "/api/v1/admin/categories/*/restore": {
    POST: { permission: PERMISSIONS.CATEGORIES_RESTORE },
  },
  "/api/v1/admin/categories/*/permanent": {
    DELETE: { permission: PERMISSIONS.CATEGORIES_PERMANENT_DELETE },
  },
  // =============================================
  // Collections API
  // =============================================
  "/api/v1/admin/collections": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    POST: { permission: PERMISSIONS.COLLECTIONS_CREATE },
  },
  "/api/v1/admin/collections/bulk-activate": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },
  "/api/v1/admin/collections/bulk-deactivate": {
    POST: { permission: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS },
  },
  "/api/v1/admin/collections/bulk-delete": {
    POST: { permission: PERMISSIONS.COLLECTIONS_DELETE },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/v1/admin/collections/bulk-restore": {
    POST: { permission: PERMISSIONS.COLLECTIONS_RESTORE },
  },
  "/api/v1/admin/collections/reorder": {
    POST: { permission: PERMISSIONS.COLLECTIONS_EDIT },
  },
  "/api/v1/admin/collections/*": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
    PUT: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    PATCH: { permission: PERMISSIONS.COLLECTIONS_EDIT },
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  "/api/v1/admin/collections/*/sections/*": {
    GET: { permission: PERMISSIONS.COLLECTIONS_VIEW },
  },
  "/api/v1/admin/collections/*/products": {
    POST: { permission: PERMISSIONS.COLLECTIONS_EDIT },
  },
  "/api/v1/admin/collections/*/restore": {
    POST: { permission: PERMISSIONS.COLLECTIONS_RESTORE },
  },
  "/api/v1/admin/collections/*/permanent": {
    DELETE: { permission: PERMISSIONS.COLLECTIONS_DELETE },
  },
  // =============================================
  // Attributes API (under /api/v1/admin/)
  // =============================================
  "/api/v1/admin/attributes": {
    // The product page names the attributes a product carries.
    GET: { anyOf: [PERMISSIONS.ATTRIBUTES_VIEW, PERMISSIONS.PRODUCTS_VIEW] },
    POST: { permission: PERMISSIONS.ATTRIBUTES_CREATE },
  },
  "/api/v1/admin/attributes/bulk-delete": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/bulk-restore": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/values/search": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
  },
  "/api/v1/admin/attributes/*": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PATCH: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/*/restore": {
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
  "/api/v1/admin/attributes/*/permanent": {
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_DELETE },
  },
  "/api/v1/admin/attributes/*/usage": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
  },
  "/api/v1/admin/attributes/*/values": {
    GET: { permission: PERMISSIONS.ATTRIBUTES_VIEW },
    POST: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    PUT: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
    DELETE: { permission: PERMISSIONS.ATTRIBUTES_EDIT },
  },
};
