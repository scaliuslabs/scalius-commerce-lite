import type { RealtimeTopic } from "@scalius/shared/realtime";

/**
 * Tables whose writes the dashboard hears as a table-level `changed` (no
 * ids): the write observers (middleware/event-dispatch.ts, and
 * background/payment-events.ts for payments applied after the response)
 * report them. Tables without events (the inbox, reviews, courier shipments,
 * payment attempts) and topics with no outbox demand depend on this; evented tables also get
 * outbox notices with ids (realtime/publish.ts). Kept free of imports beyond
 * a type: the middleware runs in every route family.
 */
export const REALTIME_TABLE_TOPICS: Readonly<Record<string, RealtimeTopic>> = {
  orders: "orders",
  order_fulfillments: "orders",
  order_returns: "returns",
  products: "products",
  product_channel_publications: "products",
  inventory_movements: "inventory",
  purchase_orders: "inventory",
  inventory_transfers: "inventory",
  customers: "customers",
  customer_addresses: "customers",
  customer_marketing_consents: "customers",
  conversations: "inbox",
  conversation_messages: "inbox",
  conversation_cart_shares: "inbox",
  product_reviews: "reviews",
  delivery_shipments: "orders",
  order_payments: "payments",
  payment_session_attempts: "payments",
};

export const REALTIME_TABLES: ReadonlySet<string> = new Set(Object.keys(REALTIME_TABLE_TOPICS));
