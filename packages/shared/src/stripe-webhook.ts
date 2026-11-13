// What a Stripe webhook endpoint must send for Scalius to apply payments,
// refunds and disputes. One list: the Stripe adapter handles exactly these events, and the
// dashboard's setup help names them. Browser-safe.

/** The events the adapter applies; any other is acknowledged and ignored. */
export const STRIPE_WEBHOOK_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  // Disputes (chargebacks): each carries the whole dispute, so any of them
  // brings the order up to date; all five keep the order's money and the
  // evidence deadline current.
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
] as const;
export type StripeWebhookEvent = (typeof STRIPE_WEBHOOK_EVENTS)[number];

/**
 * The Stripe API version every request carries and the version to choose for
 * the webhook endpoint. A new `stripe` package must not move it silently:
 * change it here, after reading the version's changelog.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/**
 * The adapter reads each event's whole object (`data.object`), so the
 * endpoint must send Snapshot payloads; Thin events carry only a reference.
 */
export const STRIPE_WEBHOOK_PAYLOAD_STYLE = "Snapshot";
