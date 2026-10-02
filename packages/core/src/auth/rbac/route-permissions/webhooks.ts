// Route permissions for webhook endpoints and the store event log (COMMERCE-HOOKS H3).
// Webhooks send order, customer and product data to third parties: like agent
// access, they are Super Admin by default (see auto-seed.ts).
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const WEBHOOK_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/webhooks": {
    GET: { permission: PERMISSIONS.WEBHOOKS_VIEW },
    POST: { permission: PERMISSIONS.WEBHOOKS_MANAGE },
  },
  "/api/v1/admin/webhooks/*": {
    GET: { permission: PERMISSIONS.WEBHOOKS_VIEW },
    PATCH: { permission: PERMISSIONS.WEBHOOKS_MANAGE },
    DELETE: { permission: PERMISSIONS.WEBHOOKS_MANAGE },
  },
  "/api/v1/admin/webhooks/*/rotate-secret": {
    POST: { permission: PERMISSIONS.WEBHOOKS_MANAGE },
  },
  "/api/v1/admin/webhooks/*/test": {
    POST: { permission: PERMISSIONS.WEBHOOKS_MANAGE },
  },
  "/api/v1/admin/webhooks/*/deliveries": {
    GET: { permission: PERMISSIONS.WEBHOOKS_VIEW },
  },
  "/api/v1/admin/webhooks/*/deliveries/*/retry": {
    POST: { permission: PERMISSIONS.WEBHOOKS_MANAGE },
  },
  "/api/v1/admin/events": {
    GET: { permission: PERMISSIONS.WEBHOOKS_VIEW },
  },
};
