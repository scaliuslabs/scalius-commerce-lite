// The state lists of the sealed resource representations (audit L7): order,
// payment, refund, return, shipment and fulfilment states, as webhook
// deliveries and the stable app API carry them (`events-representations.ts`).
// The stored columns mirror them (`packages/database/__tests__/resource-states.test.ts`).
//
// Every list here is one an app reads, so it is open: a release may add a
// member (never rename, repurpose or drop one), and each list says below what
// an app does with a value it does not know (value-lists.test.ts holds the
// comments and the docs to it). Where an app sends one of these values (a
// filter, a status it asks for), the operation accepts only the values it
// lists, and that list only widens.
//
// Which axis answers which question: `paymentStatus` is the authority for
// money (paid, refunded), `fulfillmentStatus` (with the fulfilments) for
// hand-over, and `status` is the order's workflow stage. The stages
// `shipped`, `delivered`, `returned`, `refunded` and `incomplete` are
// permanent workflow stages like the others: the store's own rules move
// orders through them (cash on delivery is collected only on a shipped or
// delivered order), and an app may rely on them as stages. A stage is not a
// money or hand-over fact: `refunded` says the order's workflow ended in a
// refund, `paymentStatus` says how much came back.
import { COURIER_SHIPMENT_STATUSES } from "./plugins/providers/courier";
import { STORE_SHIPMENT_STATUSES } from "./shipment-state";

/** An order's workflow stage (`OrderResource.status`, moved by ORDER_MACHINE). The list may grow: treat an unknown status as a stage you do not act on. */
export { ORDER_STATUSES } from "./order-state";
/** An order's money (`OrderResource.paymentStatus`), from its payments. The list may grow: treat an unknown value as not paid. */
export { PAYMENT_STATUSES } from "./order-state";
/** An order's hand-over (`OrderResource.fulfillmentStatus`), from its fulfilments. The list may grow: treat an unknown value as not handed over. */
export { FULFILLMENT_STATUSES } from "./order-state";
/** Where an order came in (`OrderResource.channel`). The list may grow: treat an unknown channel as one with no handling of its own. */
export { ORDER_CHANNELS } from "./order-channel";
/** How an order line reaches the buyer (`fulfillmentType`). The list may grow: treat an unknown type as a line you do not hand over. */
export { FULFILLMENT_TYPES } from "./fulfilment";
/** A fulfilment record's state (`FulfillmentResource.status`). The list may grow: treat an unknown value as not counting, like `voided`. */
export { FULFILLMENT_RECORD_STATUSES } from "./fulfilment";

/**
 * A payment record's state (`PaymentResource.status`): a charge's or a refund
 * record's, by its `type`, each moved by its machine (payment-record-state.ts).
 * The list may grow: treat an unknown status as money not taken, like `pending`.
 */
export const PAYMENT_RECORD_STATUSES = ["pending", "succeeded", "failed", "refunded", "cancelled", "authorized"] as const;

/** What a payment record is (`PaymentResource.type`): the whole amount, a deposit, the balance after one, or money given back. The list may grow: treat an unknown type as a record you do not count. */
export const PAYMENT_RECORD_TYPES = ["full", "deposit", "balance", "refund"] as const;

/** A refund command's state (`RefundResource.status`). The list may grow: treat an unknown status as not refunded yet, like `pending`. */
export const REFUND_STATUSES = ["pending", "refunded", "failed", "partial"] as const;

/** Where a refund's money goes (`RefundResource.settlement`). The list may grow: treat an unknown settlement as one you do not act on. */
export const REFUND_SETTLEMENTS = ["original", "store_credit"] as const;

/** A return's state (`ReturnResource.status`, moved by RETURN_MACHINE). The list may grow: treat an unknown status as a return still open. */
export const RETURN_STATUSES = ["requested", "approved", "receiving", "completed", "rejected", "cancelled"] as const;

/** Who opened a return (`ReturnResource.source`); `app` names the app in `ReturnResource.appId`. The list may grow: treat an unknown source as one with no handling of its own. */
export const RETURN_SOURCES = ["admin", "support_request", "cod_return_to_sender", "app"] as const;

/**
 * A shipment's state (`ShipmentResource.status`): a courier's normalized
 * states plus the store's own booking states, moved by SHIPMENT_MACHINE
 * (shipment-state.ts). The list may grow: treat an unknown status as a parcel
 * still open.
 */
export const SHIPMENT_STATUSES = [...COURIER_SHIPMENT_STATUSES, ...STORE_SHIPMENT_STATUSES] as const;

/** A gift card's state (`GiftCardResource.status`). Expiry is its own fact (`expiresAt`, `expired`), not a state. The list may grow: treat an unknown status as not usable, like `disabled`. */
export const GIFT_CARD_STATUSES = ["active", "disabled"] as const;

/** How a gift card came to be (`GiftCardResource.source`): sold as a product, issued by staff, or refunded as store credit. The list may grow: treat an unknown source as one with no handling of its own. */
export const GIFT_CARD_SOURCES = ["purchase", "manual", "refund"] as const;

/** A gift card ledger entry's kind (`GiftCardTransactionResource.kind`); the ledger is append-only and the balance is its projection. The list may grow: count an entry of an unknown kind by its amount, as the balance does. */
export const GIFT_CARD_TRANSACTION_KINDS = ["issue", "redeem", "release", "refund", "adjust"] as const;

/** Who wrote a gift card ledger entry (`GiftCardTransactionResource.actorType`). The list may grow: treat an unknown actor as one with no handling of its own. */
export const GIFT_CARD_ACTOR_TYPES = ["system", "admin", "customer"] as const;
