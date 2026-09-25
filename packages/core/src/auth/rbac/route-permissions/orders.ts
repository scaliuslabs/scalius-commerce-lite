// Route permissions for the order, shipment and abandoned-checkout API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const ORDER_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Orders API
  // =============================================
  "/api/v1/admin/orders": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_CREATE },
  },
  "/api/v1/admin/orders/quote": {
    POST: { permission: PERMISSIONS.ORDERS_CREATE },
  },
  "/api/v1/admin/orders/archive": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/orders/bulk-ship": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/bulk-fulfill": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/bulk-confirm": {
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/export": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/payment-recovery": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/payment-recovery/export": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/payment-recovery-link": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/amendments": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/amendments/preview": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
    PATCH: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/restore": {
    POST: { permission: PERMISSIONS.ORDERS_RESTORE },
  },
  "/api/v1/admin/orders/*/details": {
    PUT: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/timeline": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/timeline/*": {
    DELETE: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/shipments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    PATCH: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/refresh": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/reconcile": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/resolve-unknown": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/resolve-unknown/lookup": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/fulfill": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/mark-delivered": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/shipments/*/returned": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/fulfillments": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/fulfillments/*/void": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/pickup-ready": {
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/orders/*/items": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/form-data": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/payments": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/notifications": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/notifications/*/retry": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/notifications/*/resend": {
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/support-requests/*/status": {
    PUT: { permission: PERMISSIONS.ORDERS_EDIT },
    PATCH: { permission: PERMISSIONS.ORDERS_EDIT },
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/invoice": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_ISSUE_INVOICE },
  },
  "/api/v1/admin/orders/*/invoice/print": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/cod": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_EDIT },
  },
  "/api/v1/admin/orders/*/returns": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/returns/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/returns/*/approve": {
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/returns/*/receive": {
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/returns/*/cancel": {
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/returns/*/reconcile": {
    POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS },
  },
  "/api/v1/admin/orders/*/refund": {
    POST: { permission: PERMISSIONS.ORDERS_REFUND },
  },
  "/api/v1/admin/orders/*/refund-attempts/*/reconcile": {
    POST: { permission: PERMISSIONS.ORDERS_REFUND },
  },
  // =============================================
  // Shipments API
  // =============================================
  "/api/v1/admin/shipments/*": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    PUT: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
    DELETE: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  "/api/v1/admin/shipments/*/check-status": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS },
  },
  // =============================================
  // Admin Abandoned Checkouts
  // =============================================
  "/api/v1/admin/abandoned-checkouts": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/abandoned-checkouts/summaries": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/abandoned-checkouts/bulk-delete": {
    POST: { permission: PERMISSIONS.ORDERS_DELETE },
  },
  "/api/v1/admin/abandoned-checkouts/*": {
    DELETE: { permission: PERMISSIONS.ORDERS_DELETE },
  },
};
