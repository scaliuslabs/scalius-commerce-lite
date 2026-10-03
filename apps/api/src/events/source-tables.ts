/**
 * Tables whose writes fire event triggers (packages/database/scripts/
 * event-outbox-triggers.ts). Kept free of imports: the post-write flush
 * middleware runs in every route family.
 */
export const EVENT_SOURCE_TABLES: ReadonlySet<string> = new Set([
  "orders",
  "order_fulfillments",
  "order_payments",
  "order_returns",
  "products",
  "inventory_movements",
  "customers",
  "customer_addresses",
  "customer_marketing_consents",
]);
