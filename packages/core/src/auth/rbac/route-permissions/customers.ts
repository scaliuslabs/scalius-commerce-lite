// Route permissions for the customer API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const CUSTOMER_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Customers API
  // =============================================
  "/api/v1/admin/customers": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    POST: { permission: PERMISSIONS.CUSTOMERS_CREATE },
  },
  "/api/v1/admin/customers/bulk-delete": {
    POST: { permission: PERMISSIONS.CUSTOMERS_DELETE },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/v1/admin/customers/bulk-restore": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/sync": {
    POST: { permission: PERMISSIONS.CUSTOMERS_SYNC },
  },
  "/api/v1/admin/customers/*": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    PATCH: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  "/api/v1/admin/customers/*/history": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/*/restore": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/*/permanent": {
    DELETE: { permission: PERMISSIONS.CUSTOMERS_DELETE },
  },
  // Customers & marketing: tags, saved segments, export, consent.
  "/api/v1/admin/customers/tags": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/tags/bulk": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/export": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/segments": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  // A preview evaluates an unsaved filter and changes nothing.
  "/api/v1/admin/customers/segments/preview": {
    POST: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  // Deleting a saved filter deletes no customer: an edit, not customers.delete.
  "/api/v1/admin/customers/segments/*": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/segments/*/count": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/segments/*/members": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/*/tags": {
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/*/marketing": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  // The address book. Deleting an address deletes no customer: an edit.
  "/api/v1/admin/customers/*/addresses": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/*/addresses/*": {
    PUT: { permission: PERMISSIONS.CUSTOMERS_EDIT },
    DELETE: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/*/addresses/*/default": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  "/api/v1/admin/customers/*/addresses/*/default-billing": {
    POST: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
  // Saved cards on the customer page (brand and last four only). Removing one
  // stops future charges for the buyer: an edit of the customer. Apps reach
  // saved methods only through the stable payment_methods operations.
  "/api/v1/admin/customers/*/payment-methods": {
    GET: { permission: PERMISSIONS.CUSTOMERS_VIEW },
  },
  "/api/v1/admin/customers/*/payment-methods/*": {
    DELETE: { permission: PERMISSIONS.CUSTOMERS_EDIT },
  },
};
