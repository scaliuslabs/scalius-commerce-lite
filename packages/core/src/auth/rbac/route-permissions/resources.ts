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
const customersEdit = { permission: PERMISSIONS.CUSTOMERS_EDIT };
const returns = { permission: PERMISSIONS.ORDERS_CHANGE_STATUS };
const giftCards = { permission: PERMISSIONS.GIFT_CARDS_VIEW };
const giftCardsManage = { permission: PERMISSIONS.GIFT_CARDS_MANAGE };
const webhooks = { permission: PERMISSIONS.WEBHOOKS_VIEW };
const webhooksManage = { permission: PERMISSIONS.WEBHOOKS_MANAGE };
const general = { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW };
const shippingMethods = { permission: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW };
const taxes = { permission: PERMISSIONS.TAXES_VIEW };
const analytics = { permission: PERMISSIONS.DASHBOARD_ANALYTICS };
const reviews = { permission: PERMISSIONS.REVIEWS_VIEW };
const reviewsModerate = { permission: PERMISSIONS.REVIEWS_MODERATE };
const staff = { permission: PERMISSIONS.STAFF_VIEW };

export const RESOURCE_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/resources/orders": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_CREATE } },
  "/api/v1/admin/resources/orders/*": { GET: orders },
  // An app releases the hold it placed: what releasing any hold needs on the order page.
  "/api/v1/admin/resources/orders/*/release-hold": { POST: { permission: PERMISSIONS.ORDERS_CHANGE_STATUS } },
  // Recording money received against an invoice settles it (a paid order hands
  // over its gift cards and downloads): its own sensitive permission.
  "/api/v1/admin/resources/orders/*/payments": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_RECORD_PAYMENT } },
  // Payments without the buyer (a saved method charged, an authorization
  // captured or voided) take a card's money without its owner: their own
  // sensitive permission, separate from recording a payment (an app:
  // write_payment_methods; security audit N3). Reading a customer's
  // saved methods belongs to the same permission: whoever may charge them
  // lists them, and no other scope sees them.
  "/api/v1/admin/resources/orders/*/payments/charge": { POST: { permission: PERMISSIONS.ORDERS_CHARGE_SAVED_METHODS } },
  "/api/v1/admin/resources/payments/*/capture": { POST: { permission: PERMISSIONS.ORDERS_CHARGE_SAVED_METHODS } },
  "/api/v1/admin/resources/payments/*/void": { POST: { permission: PERMISSIONS.ORDERS_CHARGE_SAVED_METHODS } },
  "/api/v1/admin/resources/payment-methods": { GET: { permission: PERMISSIONS.ORDERS_CHARGE_SAVED_METHODS } },
  "/api/v1/admin/resources/payment-methods/*": { DELETE: { permission: PERMISSIONS.ORDERS_CHARGE_SAVED_METHODS } },
  // A refund gives money back: the dashboard refund permission (an app: Sensitive write_refunds).
  "/api/v1/admin/resources/orders/*/refunds": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_REFUND } },
  "/api/v1/admin/resources/orders/*/fulfillments": { GET: orders, POST: shipments },
  "/api/v1/admin/resources/orders/*/shipments": { GET: orders, POST: shipments },
  "/api/v1/admin/resources/shipments/*": { GET: orders },
  // Return writes need what the dashboard's return commands need.
  "/api/v1/admin/resources/orders/*/returns": { GET: orders, POST: returns },
  "/api/v1/admin/resources/returns/*": { GET: orders },
  "/api/v1/admin/resources/returns/*/approve": { POST: returns },
  "/api/v1/admin/resources/returns/*/receive": { POST: returns },
  "/api/v1/admin/resources/returns/*/cancel": { POST: returns },
  "/api/v1/admin/resources/discounts": { GET: { permission: PERMISSIONS.DISCOUNTS_VIEW } },
  // Store settings an app reads: each with the permission its settings page reads with (an app: read_settings).
  "/api/v1/admin/resources/markets": { GET: general },
  "/api/v1/admin/resources/markets/*": { GET: general },
  "/api/v1/admin/resources/shipping-zones": { GET: shippingMethods },
  "/api/v1/admin/resources/shipping-zones/*": { GET: shippingMethods },
  "/api/v1/admin/resources/tax-regions": { GET: taxes },
  "/api/v1/admin/resources/tax-regions/*": { GET: taxes },
  // The sales summary (an app: read_analytics).
  "/api/v1/admin/resources/analytics/summary": { GET: analytics },
  // Stock screens read locations by name; their addresses need inventory.view
  // or settings.general.view (the handler nulls them otherwise), as on
  // /admin/inventory/locations.
  "/api/v1/admin/resources/inventory-locations": {
    GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.SETTINGS_GENERAL_VIEW] },
  },
  // PIM sync creates and edits products as the editor does; stock stays with inventory.
  "/api/v1/admin/resources/products": { GET: products, POST: { permission: PERMISSIONS.PRODUCTS_CREATE } },
  // An importer creates many products in one call, under the same permission as one.
  "/api/v1/admin/resources/products/batch": { POST: { permission: PERMISSIONS.PRODUCTS_CREATE } },
  "/api/v1/admin/resources/products/*": { GET: products, PATCH: productsEdit },
  // A product's SKUs, one at a time, as the editor's option and SKU edits.
  "/api/v1/admin/resources/products/*/variants": { POST: productsEdit },
  "/api/v1/admin/resources/products/*/variants/*": { PATCH: productsEdit },
  "/api/v1/admin/resources/products/*/variants/*/restore": { POST: productsEdit },
  // An app's own trashed content; each item re-checks its type's delete permission.
  "/api/v1/admin/resources/app-content/delete": {
    POST: { anyOf: [PERMISSIONS.PRODUCTS_DELETE, PERMISSIONS.CATEGORIES_DELETE, PERMISSIONS.COLLECTIONS_DELETE, PERMISSIONS.MEDIA_DELETE] },
  },
  "/api/v1/admin/resources/variants/lookup": { POST: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] } },
  "/api/v1/admin/resources/variants/*": { GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] } },
  "/api/v1/admin/resources/customers": { GET: customers },
  "/api/v1/admin/resources/customers/*": { GET: customers },
  // Saved segments (deleting one stays the dashboard's).
  "/api/v1/admin/resources/customer-segments": { GET: customers, POST: customersEdit },
  "/api/v1/admin/resources/customer-segments/*": { GET: customers, PATCH: customersEdit },
  "/api/v1/admin/resources/customer-segments/*/members": { GET: customers },
  // Reviews read and moderate with the dashboard's review permissions; only an app writes one.
  "/api/v1/admin/resources/reviews": { GET: reviews, POST: reviewsModerate },
  "/api/v1/admin/resources/reviews/*": { GET: reviews },
  "/api/v1/admin/resources/reviews/*/status": { POST: reviewsModerate },
  // The staff directory (names and roles, never sign-in or access): its own
  // permission outside the team area, so an app may hold it.
  "/api/v1/admin/resources/staff": { GET: staff },
  "/api/v1/admin/resources/staff/*": { GET: staff },
  // Price lists read and write with the catalog, as the dashboard's editor does.
  "/api/v1/admin/resources/price-lists": { GET: products, POST: productsEdit },
  "/api/v1/admin/resources/price-lists/*": { GET: products, PATCH: productsEdit, DELETE: productsEdit },
  "/api/v1/admin/resources/price-lists/*/prices": { GET: products, PUT: productsEdit },
  // Gift cards issue and move stored value: their own sensitive permissions.
  "/api/v1/admin/resources/gift-cards": { GET: giftCards, POST: giftCardsManage },
  "/api/v1/admin/resources/gift-cards/*": { GET: giftCards, PATCH: giftCardsManage },
  "/api/v1/admin/resources/gift-cards/*/adjust": { POST: giftCardsManage },
  // Digital files and key pools read with the catalog; a buyer's access is
  // given and taken away with the order edit the dashboard's reset and revoke need.
  "/api/v1/admin/resources/digital-assets": { GET: products },
  "/api/v1/admin/resources/digital-assets/*": { GET: products },
  "/api/v1/admin/resources/digital-access": { GET: orders, POST: { permission: PERMISSIONS.ORDERS_EDIT } },
  "/api/v1/admin/resources/digital-access/*/revoke": { POST: { permission: PERMISSIONS.ORDERS_EDIT } },
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
