import type { RealtimeTopic } from "@scalius/shared/realtime";

/**
 * Tables whose writes the dashboard hears as a table-level `changed` (no
 * ids): the write observers (middleware/event-dispatch.ts, the queue
 * consumer) report them. Tables without events (the inbox, reviews, courier
 * shipments, payment attempts) depend on this; evented tables also get
 * outbox notices with ids (realtime/publish.ts). Kept free of imports beyond
 * a type: the middleware runs in every route family.
 */
export const REALTIME_TABLE_TOPICS: Readonly<Record<string, RealtimeTopic>> = {
  conversations: "inbox",
  conversation_messages: "inbox",
  product_reviews: "reviews",
  delivery_shipments: "orders",
  order_payments: "payments",
  payment_session_attempts: "payments",
};

export const REALTIME_TABLES: ReadonlySet<string> = new Set(Object.keys(REALTIME_TABLE_TOPICS));
