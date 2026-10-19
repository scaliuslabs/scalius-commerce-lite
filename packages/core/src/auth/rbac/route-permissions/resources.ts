// The stable app API's resources (/api/v1/admin/resources): each read needs
// the permission its dashboard area reads with; the order writes need the
// shipment permission the dashboard's hand-over and courier booking need.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

const orders = { permission: PERMISSIONS.ORDERS_VIEW };
const shipments = { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS };
const products = { permission: PERMISSIONS.PRODUCTS_VIEW };
const productsEdit = { permission: PERMISSIONS.PRODUCTS_EDIT };
const customers = { permission: PERMISSIONS.CUSTOMERS_VIEW };

export const RESOURCE_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/resources/orders": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_CREATE } },
  "/api/v1/admin/resources/orders/*": { GET: orders },
  "/api/v1/admin/resources/orders/*/payments": { GET: orders },
  "/api/v1/admin/resources/orders/*/fulfillments": { GET: orders, POST: shipments },
  "/api/v1/admin/resources/orders/*/shipments": { GET: orders, POST: shipments },
  "/api/v1/admin/resources/shipments/*": { GET: orders },
  "/api/v1/admin/resources/products": { GET: products },
  "/api/v1/admin/resources/products/*": { GET: products },
  "/api/v1/admin/resources/variants/lookup": { POST: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] } },
  "/api/v1/admin/resources/variants/*": { GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] } },
  "/api/v1/admin/resources/customers": { GET: customers },
  "/api/v1/admin/resources/customers/*": { GET: customers },
  // Price lists read and write with the catalog, as the dashboard's editor does.
  "/api/v1/admin/resources/price-lists": { GET: products, POST: productsEdit },
  "/api/v1/admin/resources/price-lists/*": { GET: products, PATCH: productsEdit, DELETE: productsEdit },
  "/api/v1/admin/resources/price-lists/*/prices": { GET: products, PUT: productsEdit },
};
