/**
 * Tables whose writes fire event triggers (packages/database/scripts/
 * event-outbox-triggers.ts). Kept free of imports: the post-write flush
 * middleware runs in every route family.
 */
export const EVENT_SOURCE_TABLES: ReadonlySet<string> = new Set([
  "orders",
  "order_fulfillments",
  "order_fulfillment_lines",
  "order_refunds",
  "refund_attempts",
  "order_payments",
  "order_returns",
  "products",
  "inventory_movements",
  "customers",
  "customer_addresses",
  "customer_marketing_consents",
  "product_channel_publications",
  "purchase_orders",
  "inventory_transfers",
  "delivery_shipments",
  "abandoned_checkouts",
  "promotions",
  "promotion_redemptions",
  "product_reviews",
  "gift_cards",
  "gift_card_transactions",
  "object_records",
]);
