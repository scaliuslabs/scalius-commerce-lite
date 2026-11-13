import { sql, type SQL } from "drizzle-orm";
import { orderPayments, paymentDisputes, PaymentRecordStatus, PaymentStatus, type PaymentStatusType } from "@scalius/database/schema";

/** Order payment state; every amount is integer minor units of the order currency. */
export interface ComputedOrderPaymentState {
  paidAmountMinor: number;
  balanceDueMinor: number;
  paymentStatus: PaymentStatusType;
}

export interface OrderPaymentState extends ComputedOrderPaymentState {
  /** Everything received was given back. */
  isFullRefund: boolean;
  /**
   * Money banks withdrew in disputes and have not given back
   * (`orders.disputed_minor`): the store's loss. It changes neither what was
   * paid nor what is due; the store holds `paidAmountMinor - disputedMinor`.
   */
  disputedMinor: number;
}

/** One `order_payments` row as the payment state reads it. */
export interface PaymentLedgerRow {
  paymentType: string;
  status: string;
  amountMinor: number;
}

/**
 * One dispute (`payment_disputes`) as the payment state reads it: its counted
 * amount (what its payment still held when it was recorded) counts while its
 * funds are withdrawn.
 */
export interface DisputeLedgerRow {
  funds: string;
  countedMinor: number;
}

/**
 * What an order's payment rows say it received and gave back, and what its
 * disputes took. Money given back is recorded two ways, and both count the
 * same: a refund row (`payment_type = 'refund'`, `refunded`), and a gift-card
 * tender whose hold was released by flipping its own row
 * `succeeded -> refunded` (received, then returned). Pending, authorized,
 * failed and cancelled rows hold no money. Money a bank took back in a
 * dispute (`funds = 'withdrawn'`) is `withdrawnMinor`: not given back by the
 * store, and no longer the store's.
 */
export interface PaymentLedgerTotals {
  receivedMinor: number;
  returnedMinor: number;
  withdrawnMinor: number;
}

export function paymentLedgerTotals(payments: readonly PaymentLedgerRow[], disputes: readonly DisputeLedgerRow[]): PaymentLedgerTotals {
  let receivedMinor = 0;
  let returnedMinor = 0;
  for (const payment of payments) {
    if (payment.paymentType === "refund") {
      if (payment.status === PaymentRecordStatus.REFUNDED) returnedMinor += payment.amountMinor;
      continue;
    }
    if (payment.status === PaymentRecordStatus.SUCCEEDED) receivedMinor += payment.amountMinor;
    if (payment.status === PaymentRecordStatus.REFUNDED) {
      receivedMinor += payment.amountMinor;
      returnedMinor += payment.amountMinor;
    }
  }
  let withdrawnMinor = 0;
  for (const dispute of disputes) {
    if (dispute.funds === DISPUTE_FUNDS_WITHDRAWN) withdrawnMinor += dispute.countedMinor;
  }
  return { receivedMinor, returnedMinor, withdrawnMinor };
}

/** A dispute whose amount the bank has taken from the store (disputes.ts moves `funds`). */
export const DISPUTE_FUNDS_WITHDRAWN = "withdrawn";

/**
 * The same totals as `paymentLedgerTotals`, summed in SQL for one order (the
 * order id is bound as a value), so a writer reads them with the order row in
 * one statement, under the version its CAS then pins.
 */
export function paymentLedgerTotalsSql(orderId: string): { receivedMinor: SQL<number>; returnedMinor: SQL<number>; withdrawnMinor: SQL<number> } {
  const sum = (expression: SQL) => sql<number>`(SELECT coalesce(sum(${expression}), 0) FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})`.mapWith(Number);
  return {
    receivedMinor: sum(sql`CASE WHEN ${orderPayments.paymentType} <> 'refund' AND ${orderPayments.status} IN (${PaymentRecordStatus.SUCCEEDED}, ${PaymentRecordStatus.REFUNDED}) THEN ${orderPayments.amountMinor} ELSE 0 END`),
    returnedMinor: sum(sql`CASE WHEN ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED} THEN ${orderPayments.amountMinor} ELSE 0 END`),
    withdrawnMinor: sql<number>`(SELECT coalesce(sum(CASE WHEN ${paymentDisputes.funds} = ${DISPUTE_FUNDS_WITHDRAWN} THEN ${paymentDisputes.countedMinor} ELSE 0 END), 0)
      FROM ${paymentDisputes} WHERE ${paymentDisputes.orderId} = ${orderId})`.mapWith(Number),
  };
}

/**
 * The WHERE of every write of an order's money: the order's payment rows and
 * disputes, at this point of the write's batch, still sum to the totals its
 * new state was derived from. With it the stored money is always
 * `deriveOrderPaymentState` of the rows that exist when the write commits: a
 * writer whose read went stale (the same payment landed by another apply,
 * another payment, a refund, a dispute) writes nothing, so applying one
 * payment any number of times, at once or not, counts it once.
 */
export function ledgerTotalsCondition(orderId: string, totals: PaymentLedgerTotals): SQL {
  const now = paymentLedgerTotalsSql(orderId);
  return sql`(${now.receivedMinor} = ${totals.receivedMinor} AND ${now.returnedMinor} = ${totals.returnedMinor} AND ${now.withdrawnMinor} = ${totals.withdrawnMinor})`;
}

/** An order with no payment rows and no disputes (one being placed). */
export const NO_PAYMENTS: PaymentLedgerTotals = { receivedMinor: 0, returnedMinor: 0, withdrawnMinor: 0 };

/** The totals once one more payment of `amountMinor` is received. */
export function withReceived(totals: PaymentLedgerTotals, amountMinor: number): PaymentLedgerTotals {
  return { receivedMinor: totals.receivedMinor + amountMinor, returnedMinor: totals.returnedMinor, withdrawnMinor: totals.withdrawnMinor };
}

function owed(totalAmountMinor: number, paidAmountMinor: number): Omit<OrderPaymentState, "disputedMinor"> {
  const paid = Math.max(0, paidAmountMinor);
  const balanceDueMinor = Math.max(0, totalAmountMinor - paid);
  const paymentStatus = paid <= 0 ? PaymentStatus.UNPAID : balanceDueMinor === 0 ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
  return { isFullRefund: false, paidAmountMinor: paid, balanceDueMinor, paymentStatus };
}

/**
 * The order's `paid_amount_minor`, `balance_due_minor`, `payment_status` and
 * `disputed_minor`, computed from its payment rows and disputes: the one
 * computation every writer uses (a payment landing, cash collected, a
 * recorded payment, a refund settling, a gift-card hold given back, a
 * dispute's funds moving). Payment status is a projection of the ledger,
 * never a transition.
 *
 * - Nothing given back: unpaid, partial or paid by what was received.
 * - Everything received given back: refunded, nothing paid, nothing owed.
 * - Money given back from an order that received its total: what it keeps
 *   still covers the total (an over-payment returned) reads paid; otherwise
 *   partially refunded, and the buyer owes nothing more.
 * - Money given back from an order that never received its total (a deposit,
 *   a part-paid invoice): what it keeps is paid and the rest is still owed.
 * - Money a bank withdrew in a dispute is the store's loss, not a balance the
 *   buyer owes: it changes neither paid, due nor status, and is
 *   `disputedMinor` (never more than paid: each dispute counts at most what
 *   its payment still held). Reinstated (a dispute won), it is gone again.
 */
export function deriveOrderPaymentState(input: {
  totalAmountMinor: number;
  /** An invoice (net terms) order: money it was never paid stays owed after a refund. */
  deferred?: boolean;
  /** The order's totals (`paymentLedgerTotals` of its rows and disputes, or `paymentLedgerTotalsSql`). */
  ledger: PaymentLedgerTotals;
}): OrderPaymentState {
  const totalAmountMinor = Math.max(0, input.totalAmountMinor);
  const { receivedMinor, returnedMinor } = input.ledger;
  const settled = settledState(totalAmountMinor, input.deferred === true, receivedMinor, returnedMinor);
  return { ...settled, disputedMinor: Math.min(settled.paidAmountMinor, Math.max(0, input.ledger.withdrawnMinor)) };
}

/**
 * What the store still holds of an order's money: what it was paid less what
 * banks withdrew in disputes (never below zero). Cancelling needs it to be
 * nothing; a refund can give back no more.
 */
export function heldMinor(state: { paidAmountMinor: number; disputedMinor: number }): number {
  return Math.max(0, state.paidAmountMinor - state.disputedMinor);
}

function settledState(totalAmountMinor: number, deferred: boolean, receivedMinor: number, returnedMinor: number): Omit<OrderPaymentState, "disputedMinor"> {
  const keptMinor = Math.max(0, receivedMinor - returnedMinor);
  if (returnedMinor <= 0) return owed(totalAmountMinor, keptMinor);
  // A part-paid invoice keeps owing the rest, even when all it received went back.
  if (deferred && receivedMinor < totalAmountMinor) return owed(totalAmountMinor, keptMinor);
  if (receivedMinor > 0 && returnedMinor >= receivedMinor) {
    return { isFullRefund: true, paidAmountMinor: 0, balanceDueMinor: 0, paymentStatus: PaymentStatus.REFUNDED };
  }
  if (keptMinor >= totalAmountMinor) {
    return { isFullRefund: false, paidAmountMinor: keptMinor, balanceDueMinor: 0, paymentStatus: PaymentStatus.PAID };
  }
  if (receivedMinor >= totalAmountMinor) {
    return { isFullRefund: false, paidAmountMinor: keptMinor, balanceDueMinor: 0, paymentStatus: PaymentStatus.PARTIALLY_REFUNDED };
  }
  return owed(totalAmountMinor, keptMinor);
}
