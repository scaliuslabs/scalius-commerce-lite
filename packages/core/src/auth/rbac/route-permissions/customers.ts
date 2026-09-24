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
};
