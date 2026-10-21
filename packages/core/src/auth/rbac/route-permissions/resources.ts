// The stable app API's resources (/api/v1/admin/resources): each read needs
// the permission its dashboard area reads with; the order writes need the
// shipment permission the dashboard's hand-over and courier booking need.
// Gift cards and webhook subscriptions keep their own sensitive permissions.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

const orders = { permission: PERMISSIONS.ORDERS_VIEW };
const shipments = { permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS };
const products = { permission: PERMISSIONS.PRODUCTS_VIEW };
const productsEdit = { permission: PERMISSIONS.PRODUCTS_EDIT };
const customers = { permission: PERMISSIONS.CUSTOMERS_VIEW };
const giftCards = { permission: PERMISSIONS.GIFT_CARDS_VIEW };
const giftCardsManage = { permission: PERMISSIONS.GIFT_CARDS_MANAGE };
const webhooks = { permission: PERMISSIONS.WEBHOOKS_VIEW };
const webhooksManage = { permission: PERMISSIONS.WEBHOOKS_MANAGE };

export const RESOURCE_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/resources/orders": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_CREATE } },
  "/api/v1/admin/resources/orders/*": { GET: orders },
  // Recording money received against an invoice settles it (a paid order hands
  // over its gift cards and downloads): its own sensitive permission.
  "/api/v1/admin/resources/orders/*/payments": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_RECORD_PAYMENT } },
  "/api/v1/admin/resources/orders/*/fulfillments": { GET: orders, POST: shipments },
  "/api/v1/admin/resources/orders/*/shipments": { GET: orders, POST: shipments },
  "/api/v1/admin/resources/shipments/*": { GET: orders },
  // PIM sync creates and edits products as the editor does; stock stays with inventory.
  "/api/v1/admin/resources/products": { GET: products, POST: { permission: PERMISSIONS.PRODUCTS_CREATE } },
  // An importer creates many products in one call, under the same permission as one.
  "/api/v1/admin/resources/products/batch": { POST: { permission: PERMISSIONS.PRODUCTS_CREATE } },
  "/api/v1/admin/resources/products/*": { GET: products, PATCH: productsEdit },
  // An app's own trashed content; each item re-checks its type's delete permission.
  "/api/v1/admin/resources/app-content/delete": {
    POST: { anyOf: [PERMISSIONS.PRODUCTS_DELETE, PERMISSIONS.CATEGORIES_DELETE, PERMISSIONS.COLLECTIONS_DELETE, PERMISSIONS.MEDIA_DELETE] },
  },
  "/api/v1/admin/resources/variants/lookup": { POST: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] } },
  "/api/v1/admin/resources/variants/*": { GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] } },
  "/api/v1/admin/resources/customers": { GET: customers },
  "/api/v1/admin/resources/customers/*": { GET: customers },
  // Price lists read and write with the catalog, as the dashboard's editor does.
  "/api/v1/admin/resources/price-lists": { GET: products, POST: productsEdit },
  "/api/v1/admin/resources/price-lists/*": { GET: products, PATCH: productsEdit, DELETE: productsEdit },
  "/api/v1/admin/resources/price-lists/*/prices": { GET: products, PUT: productsEdit },
  // Gift cards issue and move stored value: their own sensitive permissions.
  "/api/v1/admin/resources/gift-cards": { GET: giftCards, POST: giftCardsManage },
  "/api/v1/admin/resources/gift-cards/*": { GET: giftCards, PATCH: giftCardsManage },
  "/api/v1/admin/resources/gift-cards/*/adjust": { POST: giftCardsManage },
  // An app's own webhook subscriptions (the route refuses any other caller).
  "/api/v1/admin/resources/webhook-subscriptions": { GET: webhooks, POST: webhooksManage },
  "/api/v1/admin/resources/webhook-subscriptions/*": { PATCH: webhooksManage, DELETE: webhooksManage },
  // Bulk runs need the permission of the single write they repeat.
  "/api/v1/admin/resources/variants/bulk-set-prices": { POST: productsEdit },
  "/api/v1/admin/resources/variants/bulk-set-stock": { POST: { permission: PERMISSIONS.PRODUCTS_ADJUST_STOCK } },
  "/api/v1/admin/resources/customers/bulk-tag": { POST: { permission: PERMISSIONS.CUSTOMERS_EDIT } },
  "/api/v1/admin/resources/products/bulk-set-status": { POST: productsEdit },
  "/api/v1/admin/resources/products/bulk-publish": { POST: productsEdit },
  "/api/v1/admin/resources/bulk-runs": { GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.CUSTOMERS_VIEW] } },
  "/api/v1/admin/resources/bulk-runs/*": { GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.CUSTOMERS_VIEW] } },
};
