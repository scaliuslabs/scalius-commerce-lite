// Route permissions for store migration (imports and exports). The route
// admits a staff member who can do any part of the batch; the handler then
// requires the permission each mode needs (create needs `.create`, upsert
// needs `.create` and `.edit`, a price update `.edit`), and creating a
// brand, category or attribute along the way needs that permission too.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const STORE_TRANSFER_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/import/products": {
    POST: { anyOf: [PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_EDIT] },
  },
  "/api/v1/admin/import/product-images": {
    POST: { allOf: [PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.MEDIA_UPLOAD] },
  },
  "/api/v1/admin/import/customers": {
    POST: { anyOf: [PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.CUSTOMERS_EDIT] },
  },
  // Stock writes need the same permission as the inventory screen.
  "/api/v1/admin/import/inventory": {
    POST: { permission: PERMISSIONS.PRODUCTS_ADJUST_STOCK },
  },
  "/api/v1/admin/export/products": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/export/inventory": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
};
