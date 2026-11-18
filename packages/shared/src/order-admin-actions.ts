import {
  canProcessOrderCodAction,
  COD_MACHINE,
  normalizeStatusValue,
  ORDER_MACHINE,
  ORDER_STATUS_TRANSITIONS,
  type OrderCodAction,
  type OrderStatusValue,
} from "./order-state";

/**
 * What staff may do to an order, decided once for the server (which refuses)
 * and the dashboard (which shows the action, or why it can't be chosen), so
 * the two never disagree. Amounts are in one unit per call (the server passes
 * minor units, the dashboard the API's amounts).
 */

/**
 * The status menu's moves: only changes without side effects. Shipped,
 * delivered and returned are fulfilment facts (Mark as sent / Book courier,
 * cash collected / Mark delivered, Mark returned record what moved and move the
 * stock with it); returns and refunds are workflow-owned. A Shipped order with
 * nothing actually sent may still be cancelled; the cancel path refuses while
 * any unit is with the courier.
 */
export const GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatusValue, readonly OrderStatusValue[]>> = {
  incomplete: ["pending", "cancelled"],
  pending: ["confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["cancelled"],
  shipped: ["cancelled"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
  returned: [],
  refunded: [],
};

export function isGenericAdminOrderStatusTransitionAllowed(current: string, next: string): boolean {
  return current === next || (GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS[current as OrderStatusValue] ?? []).includes(next as OrderStatusValue);
}

/**
 * What staff can still do with an order once a chargeback on it is lost, by
 * the same moves the status menu offers: an order nothing has left may still
 * be cancelled (which restocks it) or fulfilled; once goods are sent or
 * delivered they are with the buyer and the money is gone, so there is nothing
 * to cancel; a cancelled, returned or refunded order is closed.
 */
export type LostDisputeNextStep = "cancel_or_fulfil" | "goods_out" | "closed";

export function lostDisputeNextStep(status: string, unitsSent: number): LostDisputeNextStep {
  const current = status.toLowerCase();
  if (unitsSent === 0 && isGenericAdminOrderStatusTransitionAllowed(current, "cancelled") && current !== "cancelled") return "cancel_or_fulfil";
  return current === "cancelled" || current === "returned" || current === "refunded" ? "closed" : "goods_out";
}

/** The order's money as both sides read it. */
export interface OrderMoneyFacts {
  paymentStatus?: string | null;
  /** What the buyer paid, net of refunds (`paid_amount_minor`). */
  paid?: number | null;
  /** What banks withdrew in disputes and kept (`disputed_minor`): the store's loss, never owed by the buyer. */
  disputed?: number | null;
  total?: number | null;
  balanceDue?: number | null;
  paymentMethod?: string | null;
  /** Recorded invoice terms (days); null or missing: none. */
  paymentTermsDays?: number | null;
}

/** What the store still holds of the buyer's money: paid, less what disputes took. */
export function orderHeldAmount(facts: OrderMoneyFacts): number {
  return Math.max(0, (facts.paid ?? 0) - (facts.disputed ?? 0));
}

/**
 * The order holds no money, so cancelling it needs no refund: nothing was
 * paid, or a bank took back all of it in disputes. Anything else is refunded
 * first (gift-card-only money, which cancelling gives back, is the server's
 * one other case: it needs the payment rows).
 */
export function orderHoldsNoMoney(facts: OrderMoneyFacts): boolean {
  const status = (facts.paymentStatus ?? "").trim().toLowerCase();
  const paid = facts.paid ?? 0;
  const disputed = facts.disputed ?? 0;
  if ((status === "unpaid" || status === "failed") && paid === 0) return true;
  return disputed > 0 && paid === disputed;
}

/** Why an order can't be marked delivered or completed yet: money is still due. */
export type OrderMoneyDue = "cash_not_collected" | "invoice_payment" | "rest_of_payment" | "money_due";

/**
 * Money still due before delivered or completed can be recorded, or null.
 * A partly refunded order was paid in full: its net paid amount is below the
 * total because money went back, not because any is owed.
 */
export function orderMoneyDue(facts: OrderMoneyFacts): OrderMoneyDue | null {
  const status = (facts.paymentStatus ?? "").trim().toLowerCase();
  const partlyRefunded = status === "partially_refunded";
  const due = (facts.balanceDue ?? 0) > 0 || (!partlyRefunded && (facts.total ?? 0) > (facts.paid ?? 0));
  const settled = status === "paid" || partlyRefunded;
  if (!due && settled) return null;
  if (facts.paymentMethod === "cod") return "cash_not_collected";
  if (typeof facts.paymentTermsDays === "number") return "invoice_payment";
  if (status === "partial") return "rest_of_payment";
  return "money_due";
}

/** The cancel a held order still allows: every other status move waits for staff to release the hold. */
export function moveWaitsForHold(target: string): boolean {
  return target.trim().toLowerCase() !== "cancelled";
}

/** What the server knows of an order that decides what staff may do to it now. Money in one unit per call. */
export interface OrderActionFacts extends OrderMoneyFacts {
  status: string;
  /** An app's hold for staff review is open. */
  onHold: boolean;
  /** A refund locks the order: its outcome is open or its money is being recorded (status, hand-over, courier and archive wait). */
  refundLocksOrder: boolean;
  /** Any refund is in flight, one its provider took and is completing included: another refund waits for it. */
  refundInFlight: boolean;
  /** A courier booking is being made or needs checking (the shipment claim lock). */
  courierCheck: boolean;
  /** An online payment session is being set up right now. */
  paymentInProgress: boolean;
  requiresShipping: boolean;
  fulfillmentStatus?: string | null;
  /** Units staff still hand over, by how (digital lines and gift cards hand themselves over). */
  unitsLeft: { ship: number; pickup: number; service: number };
  /** Ship units already with a courier or rider. */
  shipUnitsSent: number;
  /** Units handed over so far, of every kind. */
  unitsHandedOver: number;
  /** The buyer collects the order at a pickup point. */
  pickupOrder: boolean;
  /** Staff said the pickup order is ready to collect. */
  pickupReady: boolean;
  /** The latest courier booking is still open (not cancelled, failed or returned). */
  courierBooked: boolean;
  /** The buyer asked to cancel and staff haven't answered. */
  cancellationRequested: boolean;
  /** The cash-on-delivery record's state; null when the order has none. */
  codStatus: string | null;
  /** No payment is still being processed and the payment rows hold no money (the cancel's ledger check). */
  paymentRecordsSettled: boolean;
  /** The order's money is gift-card tender only, which cancelling gives back. */
  giftCardOnly: boolean;
  /** The order's payment plan status (a deposit online, the balance in cash); null without a plan. */
  paymentPlanStatus: string | null;
}

/** Why an action can't be taken now: a stable code each surface words itself. */
export const ORDER_ACTION_BLOCKS = [
  "refund_in_progress",
  "courier_check",
  "payment_in_progress",
  "on_hold",
  "status",
  "handed_over",
  "cancel_needs_refund",
  "payment_unsettled",
  "cash_not_collected",
  "money_due",
  "not_all_sent",
  "nothing_to_hand_over",
  "not_cash_on_delivery",
  "deposit_not_paid",
  "nothing_due",
  "cash_settled",
  "nothing_to_refund",
  "not_pickup",
  "already_ready",
] as const;
export type OrderActionBlock = (typeof ORDER_ACTION_BLOCKS)[number];

export interface OrderActionState {
  available: boolean;
  /** Null exactly when available. */
  reason: OrderActionBlock | null;
}

/** The one next step of an order, as the order page's primary button and the orders list name it. */
export const ORDER_NEXT_STEPS = [
  "review_cancellation",
  "confirm",
  "send_rest",
  "ship",
  "mark_ready_for_pickup",
  "mark_picked_up",
  "mark_service_done",
  "collect_cash",
  "mark_delivered",
] as const;
export type OrderNextStep = (typeof ORDER_NEXT_STEPS)[number];

export interface OrderAdminActions {
  /** The status menu's moves, in the order the order machine lists them. */
  moves: Array<{ status: OrderStatusValue } & OrderActionState>;
  /** Handing units over: send, pickup, service done. */
  handOver: OrderActionState;
  /** Sending the ship lines left (Mark as sent, or a courier booking). */
  send: OrderActionState;
  /** Mark delivered (everything sent, by your own rider). */
  deliver: OrderActionState;
  /** Mark a pickup order ready to collect (the buyer is told). */
  pickupReady: OrderActionState;
  /** The cash at the door: collected, a failed attempt, returned to sender. */
  cod: { collect: OrderActionState; fail: OrderActionState; return: OrderActionState };
  refund: OrderActionState;
  next: OrderNextStep | null;
}

const OK: OrderActionState = { available: true, reason: null };
const blocked = (reason: OrderActionBlock): OrderActionState => ({ available: false, reason });
const HANDOVER_STATUSES = new Set(["confirmed", "shipped", "delivered"]);

/** Work in progress that stops every command on the order. */
function orderLock(facts: OrderActionFacts): OrderActionBlock | null {
  if (facts.refundLocksOrder) return "refund_in_progress";
  if (facts.courierCheck) return "courier_check";
  if (facts.paymentInProgress) return "payment_in_progress";
  return null;
}

function moveState(facts: OrderActionFacts, target: OrderStatusValue): OrderActionState {
  if (facts.onHold && moveWaitsForHold(target)) return blocked("on_hold");
  const lock = orderLock(facts);
  if (lock) return blocked(lock);
  if (target === "cancelled") {
    if (facts.unitsHandedOver > 0) return blocked("handed_over");
    // Gift-card tender only: cancelling gives the cards back, no refund first.
    if (facts.giftCardOnly) return OK;
    if (!orderHoldsNoMoney(facts)) return blocked("cancel_needs_refund");
    if (!facts.paymentRecordsSettled) return blocked("payment_unsettled");
  }
  if (target === "completed") {
    const due = orderMoneyDue(facts);
    // A cash order completes once its collection is recorded, whatever the amounts say.
    if (due === "cash_not_collected" || (facts.paymentMethod === "cod" && facts.codStatus !== "collected")) {
      return blocked("cash_not_collected");
    }
    if (due) return blocked("money_due");
  }
  return OK;
}

function handOverState(facts: OrderActionFacts, status: string): OrderActionState {
  const lock = orderLock(facts);
  if (lock) return blocked(lock);
  if (facts.onHold) return blocked("on_hold");
  if (!HANDOVER_STATUSES.has(status)) return blocked("status");
  const left = facts.unitsLeft;
  return left.ship + left.pickup + left.service > 0 ? OK : blocked("nothing_to_hand_over");
}

const OPEN_PICKUP_STATUSES = new Set(["pending", "processing", "confirmed"]);

function pickupReadyState(facts: OrderActionFacts, status: string): OrderActionState {
  if (!facts.pickupOrder) return blocked("not_pickup");
  if (facts.pickupReady) return blocked("already_ready");
  if (!OPEN_PICKUP_STATUSES.has(status)) return blocked("status");
  if (facts.fulfillmentStatus === "complete") return blocked("nothing_to_hand_over");
  // Telling the buyer to come waits only for a courier check, not for a hold or a refund.
  return facts.courierCheck ? blocked("courier_check") : OK;
}

function deliverState(facts: OrderActionFacts, status: string): OrderActionState {
  const lock = orderLock(facts);
  if (lock) return blocked(lock);
  if (status !== "shipped") return blocked("status");
  const left = facts.unitsLeft;
  // A service still to do holds back delivery only when nothing ships.
  if (left.ship + left.pickup + (facts.requiresShipping ? 0 : left.service) > 0) return blocked("not_all_sent");
  // Cash is delivered before it is remitted, an invoice before it is paid; anything else once nothing is due.
  if (facts.paymentMethod === "cod" || typeof facts.paymentTermsDays === "number") return OK;
  const due = orderMoneyDue(facts);
  return due ? blocked(due === "cash_not_collected" ? "cash_not_collected" : "money_due") : OK;
}

function codState(facts: OrderActionFacts, status: string, action: OrderCodAction): OrderActionState {
  const lock = orderLock(facts);
  if (lock) return blocked(lock);
  if (action === "collected") {
    // Cash is taken for a cash order, or for a plan's balance once its deposit is paid.
    if (facts.paymentPlanStatus !== null) {
      if (facts.paymentPlanStatus !== "deposit_paid") return blocked("deposit_not_paid");
    } else if (facts.paymentMethod !== "cod") {
      return blocked("not_cash_on_delivery");
    }
    if ((facts.total ?? 0) - (facts.paid ?? 0) <= 0) return blocked("nothing_due");
  } else if (facts.codStatus === null) {
    // A failed attempt and a return to sender move the cash record; without one there is none to move.
    return blocked("not_cash_on_delivery");
  }
  // A part-sent order has a parcel out too: its failed attempt is recorded the same way.
  const partSent = action === "failed" && status === "confirmed" && facts.fulfillmentStatus === "partial";
  if (!partSent && !canProcessOrderCodAction(status, action, { requiresShipping: facts.requiresShipping })) return blocked("status");
  if (action === "collected" && status !== "delivered") {
    // Collecting delivers the order, which needs every line that gates delivery handed over.
    const left = facts.unitsLeft;
    if (left.ship + left.pickup + (facts.requiresShipping ? 0 : left.service) > 0) return blocked("not_all_sent");
  }
  return COD_MACHINE.can(facts.codStatus ?? "pending", action) ? OK : blocked("cash_settled");
}

function refundState(facts: OrderActionFacts): OrderActionState {
  // Another refund waits for every refund in flight, one on its way included.
  if (facts.refundInFlight || facts.refundLocksOrder) return blocked("refund_in_progress");
  const lock = orderLock(facts);
  if (lock) return blocked(lock);
  const status = (facts.paymentStatus ?? "").trim().toLowerCase();
  const refundable = orderHeldAmount(facts) > 0 && status !== "refunded" && status !== "unpaid" && status !== "failed";
  return refundable ? OK : blocked("nothing_to_refund");
}

/**
 * Everything staff may do to an order now, each action available or blocked
 * with its reason, and the one next step. The server lists this with every
 * order it reads and refuses by the same rules; the dashboard only renders it.
 */
export function orderAdminActions(facts: OrderActionFacts): OrderAdminActions {
  const status = normalizeStatusValue(facts.status);
  const known = ORDER_MACHINE.is(status);
  const moves = known
    ? ORDER_STATUS_TRANSITIONS[status]
      .filter((target) => GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS[status].includes(target))
      .map((target) => ({ status: target, ...moveState(facts, target) }))
    : [];
  const handOver = handOverState(facts, status);
  const deliver = deliverState(facts, status);
  const cod = {
    collect: codState(facts, status, "collected"),
    fail: codState(facts, status, "failed"),
    return: codState(facts, status, "returned"),
  };
  return {
    moves,
    handOver,
    send: handOver.available && facts.unitsLeft.ship === 0 ? blocked("nothing_to_hand_over") : handOver,
    deliver,
    pickupReady: pickupReadyState(facts, status),
    cod,
    refund: refundState(facts),
    next: nextStep(facts, status, moves, handOver, deliver, cod.collect),
  };
}

/**
 * The one next step: answer a cancellation request → send the rest of a
 * part-sent order → confirm → hand over (ship it; mark a pickup ready, then
 * picked up; mark a service done) → collect the cash → mark delivered. A held
 * order's next step is the hold notice's Release, so it has none here.
 */
function nextStep(
  facts: OrderActionFacts,
  status: string,
  moves: OrderAdminActions["moves"],
  handOver: OrderActionState,
  deliver: OrderActionState,
  collect: OrderActionState,
): OrderNextStep | null {
  if (orderLock(facts)) return null;
  if (facts.cancellationRequested) return "review_cancellation";
  if (facts.onHold) return null;
  const left = facts.unitsLeft;
  if (handOver.available && facts.shipUnitsSent > 0 && left.ship > 0) return "send_rest";
  if (status === "pending" || status === "processing") {
    return moves.some((move) => move.status === "confirmed" && move.available) ? "confirm" : null;
  }
  if (status === "confirmed" && left.ship > 0) {
    // A courier booking still open is on its way to being sent.
    return facts.courierBooked || facts.fulfillmentStatus === "complete" ? null : "ship";
  }
  if (handOver.available) {
    if (left.pickup > 0) return facts.pickupReady ? "mark_picked_up" : "mark_ready_for_pickup";
    if (left.service > 0) return "mark_service_done";
  }
  if (facts.paymentMethod === "cod" && (facts.balanceDue ?? 0) > 0 && collect.available) return "collect_cash";
  return deliver.available ? "mark_delivered" : null;
}
