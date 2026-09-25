// Route permissions for the warranty API (Wave B design §7.2). Policies are
// product setup (the product editor lists them, so reads follow product view);
// claims are order records backed by a conversation thread.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const WARRANTY_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/warranty-policies": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/warranty-policies/*": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/warranty-claims": {
    GET: { permission: PERMISSIONS.ORDERS_VIEW },
  },
  "/api/v1/admin/orders/*/warranty-claims": {
    POST: { allOf: [PERMISSIONS.ORDERS_EDIT, PERMISSIONS.CONVERSATIONS_REPLY] },
  },
  "/api/v1/admin/warranty-claims/*": {
    PATCH: { allOf: [PERMISSIONS.ORDERS_EDIT, PERMISSIONS.CONVERSATIONS_REPLY] },
  },
};
