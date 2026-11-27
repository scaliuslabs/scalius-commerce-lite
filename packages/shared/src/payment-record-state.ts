// A payment record's machines (`order_payments.status`, `PaymentResource.status`).
// A record is one of two kinds, fixed by its `type` when it is written:
//
// - a charge (`full`, `deposit`, `balance`): money the buyer pays, moved by
//   the payment provider's events (`PAYMENT_EVENT_KINDS` of the payment port)
//   and by the store's own steps (a void, switching an order to another
//   gateway, giving back a gift card's tender);
// - a refund record (`refund`): money the store gives back, moved with its
//   refund attempt.
//
// The server writes a record's status only as a move of its kind's machine
// (`paymentMove` and `refundRecordMove` in core), whose update names the
// move's source states. Readers ask the lists below instead of retyping them.
import { defineMachine } from "./machine";
import type { PaymentType } from "./plugins/providers/payment";

/**
 * A charge's kind where its row is inserted: the type refuses `refund`, and
 * the writers gate reads the call as a charge, so the insert's status is
 * checked against the charge machine's initial states.
 */
export function chargeKind<T extends PaymentType>(kind: T): T {
  return kind;
}

/** A charge's states: a subset of PAYMENT_RECORD_STATUSES. */
export const CHARGE_STATUSES = ["pending", "authorized", "succeeded", "failed", "cancelled", "refunded"] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/**
 * A charge, moved by its provider's events. A session opens it `pending`;
 * cash, a recorded payment and a gift card's tender start `succeeded`; a
 * provider event for a charge the store has no row for starts it in the
 * event's own state (`authorized`, `failed`).
 */
export const PAYMENT_MACHINE = defineMachine({
  name: "payment",
  states: CHARGE_STATUSES,
  initial: ["pending", "authorized", "succeeded", "failed"],
  final: ["cancelled", "refunded"],
  moves: {
    /** The provider's `confirmed` event, or a capture of an authorization: money taken. A late confirmation after a failure counts. */
    confirmed: { from: ["pending", "failed", "authorized"], to: "succeeded" },
    /** The provider's `authorized` event: money held at the provider, nothing paid until a capture confirms it. */
    authorized: { from: ["pending", "failed"], to: "authorized" },
    /** The provider's `failed` event for an attempt. */
    failed: { from: ["pending"], to: "failed" },
    /**
     * The provider's `cancelled` or `failed` event naming an authorization,
     * a void of it, or the store switching the order to another gateway (its
     * pending charge). Captured money is never cancelled: it goes back as a refund record.
     */
    cancelled: { from: ["pending", "authorized"], to: "cancelled" },
    /** A gift card's tender given back to the card (the order cancelled): the only charge a refund moves. */
    released: { from: ["succeeded"], to: "refunded" },
  },
});
export type PaymentMove = keyof typeof PAYMENT_MACHINE.moves;

/** A refund record's states: a subset of PAYMENT_RECORD_STATUSES. */
export const REFUND_RECORD_STATUSES = ["pending", "refunded", "failed"] as const;
export type RefundRecordStatus = (typeof REFUND_RECORD_STATUSES)[number];

/**
 * A refund record, moved with its refund attempt. A provider refund starts
 * `pending`; one the store settles itself (a gift card, store credit) starts
 * `refunded`.
 */
export const REFUND_RECORD_MACHINE = defineMachine({
  name: "refund record",
  states: REFUND_RECORD_STATUSES,
  initial: ["pending", "refunded"],
  final: ["failed"],
  moves: {
    /** The provider completed it (or the store settled it). */
    refunded: { from: ["pending"], to: "refunded" },
    /** The provider refused it, or it was never sent. */
    failed: { from: ["pending"], to: "failed" },
    /** The provider says a refund it completed failed after all (the buyer's bank returned it). */
    reversed: { from: ["refunded"], to: "failed" },
    /** The provider put a refund it completed back in progress. */
    reopened: { from: ["refunded"], to: "pending" },
  },
});
export type RefundRecordMove = keyof typeof REFUND_RECORD_MACHINE.moves;

/** A charge whose money is still on its way: an order holding one cannot be cancelled or switch gateway. */
export const PAYMENT_IN_FLIGHT_STATUSES = ["pending", "authorized"] as const satisfies readonly ChargeStatus[];

/** A charge that holds or may hold the buyer's money: in flight, or taken. */
export const PAYMENT_HOLDING_STATUSES = [...PAYMENT_IN_FLIGHT_STATUSES, "succeeded"] as const satisfies readonly ChargeStatus[];

/** A charge the provider landed: money held or taken, or taken and later given back. */
export const PAYMENT_LANDED_STATUSES = ["authorized", "succeeded", "refunded"] as const satisfies readonly ChargeStatus[];
