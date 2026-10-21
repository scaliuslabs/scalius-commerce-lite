// The closed state lists of the sealed resource representations (audit L7):
// order, payment, refund, return, shipment and fulfilment states, as webhook
// deliveries and the stable app API carry them (`events-representations.ts`).
// They are enums in the sealed schemas, so a renamed or removed state is a
// reviewed break and a new one an explicit additive change. The stored
// columns mirror them (`packages/database/__tests__/resource-states.test.ts`).
//
// Which axis answers which question: `paymentStatus` is the authority for
// money (paid, refunded), `fulfillmentStatus` (with the fulfilments) for
// hand-over, and `status` is the order's workflow stage. `status` values
// such as `shipped`, `delivered`, `returned` and `refunded` summarise the
// other two for people; an app decides payment and fulfilment questions from
// their own axes.
import { COURIER_SHIPMENT_STATUSES } from "./plugins/providers/courier";

export { ORDER_STATUSES, PAYMENT_STATUSES, FULFILLMENT_STATUSES } from "./order-state";
export { ORDER_CHANNELS } from "./order-channel";
export { FULFILLMENT_TYPES, FULFILLMENT_RECORD_STATUSES } from "./fulfilment";

/** A payment record's state (`PaymentResource.status`). */
export const PAYMENT_RECORD_STATUSES = ["pending", "confirmed", "succeeded", "failed", "refunded", "cancelled", "authorized"] as const;

/** What a payment record is (`PaymentResource.type`): the whole amount, a deposit, the balance after one, or money given back. */
export const PAYMENT_RECORD_TYPES = ["full", "deposit", "balance", "refund"] as const;

/** A refund command's state (`RefundResource.status`). */
export const REFUND_STATUSES = ["pending", "refunded", "failed", "partial"] as const;

/** Where a refund's money goes (`RefundResource.settlement`). */
export const REFUND_SETTLEMENTS = ["original", "store_credit"] as const;

/** A return's state (`ReturnResource.status`). */
export const RETURN_STATUSES = ["requested", "approved", "receiving", "completed", "rejected", "cancelled"] as const;

/** Who opened a return (`ReturnResource.source`). */
export const RETURN_SOURCES = ["admin", "support_request", "cod_return_to_sender"] as const;

/** A shipment's state (`ShipmentResource.status`): a courier's normalized states plus the store's own booking states. */
export const SHIPMENT_STATUSES = [...COURIER_SHIPMENT_STATUSES, "creating", "processing", "reconcile_required"] as const;
