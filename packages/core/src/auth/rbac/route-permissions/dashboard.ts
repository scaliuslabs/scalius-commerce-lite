// Route permissions for the analytics, dashboard and search API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const DASHBOARD_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Analytics API
  // =============================================
  "/api/v1/admin/analytics": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    POST: { permission: PERMISSIONS.ANALYTICS_CREATE },
  },
  "/api/v1/admin/analytics/*": {
    GET: { permission: PERMISSIONS.ANALYTICS_VIEW },
    PUT: { permission: PERMISSIONS.ANALYTICS_EDIT },
    PATCH: { permission: PERMISSIONS.ANALYTICS_EDIT },
    DELETE: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/analytics/*/source": {
    GET: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/analytics/*/restore": {
    POST: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/analytics/*/permanent": {
    DELETE: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  "/api/v1/admin/analytics/*/toggle": {
    POST: { permission: PERMISSIONS.ANALYTICS_TOGGLE },
  },
  // =============================================
  // Search API
  // =============================================
  "/api/v1/admin/search": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/search/reindex": {
    POST: { permission: PERMISSIONS.PRODUCTS_BULK_OPERATIONS },
  },
  // =============================================
  // Dashboard API
  // =============================================
  "/api/v1/admin/dashboard": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
  "/api/v1/admin/dashboard/*": {
    GET: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
};
