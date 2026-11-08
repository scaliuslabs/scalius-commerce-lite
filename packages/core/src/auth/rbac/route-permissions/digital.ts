// Route permissions for the digital-goods API (Wave B design §7.2): assets,
// uploads and licence-key pools are part of editing a product; resending what
// an order line received is an order edit. Resetting or revoking a buyer's
// access has its own permission, the one an app's digital_access.grant and
// .revoke need (`write_digital_access`), so editing orders never includes an
// undoable revoke.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const DIGITAL_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/products/*/digital-assets": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*": {
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*/uploads": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*/uploads/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*/uploads/*/parts/*": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*/uploads/*/complete": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*/licence-keys": {
    GET: { permission: PERMISSIONS.PRODUCTS_EDIT },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/digital-assets/*/licence-keys/revoke": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/orders/*/digital/resend": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/digital-entitlements/*/reset": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_DIGITAL_ACCESS },
  },
  "/api/v1/admin/digital-entitlements/*/revoke": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_DIGITAL_ACCESS },
  },
};
