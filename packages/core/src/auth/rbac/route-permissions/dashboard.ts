// Route permissions for the analytics integrations, dashboard, reports and search API.
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
  // One test event to Meta, GA4 (validation server) or TikTok (audit spec S4).
  "/api/v1/admin/analytics/test-event": {
    POST: { permission: PERMISSIONS.ANALYTICS_EDIT },
  },
  // =============================================
  // Search API
  // =============================================
  // The ⌘K search: open to any staff member; each kind of record is searched
  // only when the caller may read that kind's list (checked in the route).
  "/api/v1/admin/search/global": {
    GET: { allowAnyAdmin: true },
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
  // Dismissing the setup guide: one staff member's own preference.
  "/api/v1/admin/dashboard/setup-guide/dismiss": {
    POST: { permission: PERMISSIONS.DASHBOARD_VIEW },
  },
  // =============================================
  // Analytics overview and reports (sales numbers). Reports naming customers
  // also need customers.view, checked by the route.
  // =============================================
  "/api/v1/admin/reports": {
    GET: { permission: PERMISSIONS.DASHBOARD_ANALYTICS },
  },
  "/api/v1/admin/reports/*": {
    GET: { permission: PERMISSIONS.DASHBOARD_ANALYTICS },
  },
  "/api/v1/admin/reports/*/export": {
    GET: { permission: PERMISSIONS.DASHBOARD_ANALYTICS },
  },
};
