// Route permissions for the staff account, role and device-token API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const STAFF_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // RBAC API
  // =============================================
  "/api/v1/admin/rbac/roles": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/v1/admin/rbac/roles/*": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
    PUT: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/v1/admin/rbac/permissions": {
    GET: { anyOf: [PERMISSIONS.TEAM_VIEW, PERMISSIONS.TEAM_MANAGE_ROLES] },
  },
  "/api/v1/admin/rbac/my-permissions": {
    GET: { allowAnyAdmin: true },
  },
  "/api/v1/admin/rbac/user-roles": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  "/api/v1/admin/rbac/user-permissions": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE_ROLES },
  },
  // =============================================
  // FCM Token API
  // =============================================
  "/api/v1/admin/fcm-token": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/fcm-token-cleanup": {
    POST: { permission: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT },
  },
  // =============================================
  // Auth Management API (admin user CRUD, 2FA, profile)
  // =============================================
  "/api/v1/admin/auth/users": {
    GET: {
      anyOf: [
        PERMISSIONS.TEAM_VIEW,
        PERMISSIONS.TEAM_MANAGE,
        PERMISSIONS.TEAM_MANAGE_ROLES,
      ],
    },
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/users/*": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
    DELETE: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/users/*/suspension": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/users/*/resend-setup": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/users/*/remove": {
    POST: { permission: PERMISSIONS.TEAM_MANAGE },
  },
  "/api/v1/admin/auth/change-password": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/update-profile": {
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/scanner-link": {
    POST: {
      allOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT],
    },
  },
  "/api/v1/admin/auth/2fa/*": {
    GET: { allowAnyAdmin: true },
    POST: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/account-security": {
    GET: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/sessions": {
    GET: { allowAnyAdmin: true },
    DELETE: { allowAnyAdmin: true },
  },
  "/api/v1/admin/auth/sessions/*": {
    DELETE: { allowAnyAdmin: true },
  },
};
