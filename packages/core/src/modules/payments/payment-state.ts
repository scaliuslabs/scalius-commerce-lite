import { sql, type SQL } from "drizzle-orm";
import { orderPayments, PaymentRecordStatus, PaymentStatus, type PaymentStatusType } from "@scalius/database/schema";

/** Order payment state; every amount is integer minor units of the order currency. */
export interface ComputedOrderPaymentState {
  paidAmountMinor: number;
  balanceDueMinor: number;
  paymentStatus: PaymentStatusType;
}

export interface OrderPaymentState extends ComputedOrderPaymentState {
  /** Everything received was given back. */
  isFullRefund: boolean;
}

/** One `order_payments` row as the payment state reads it. */
export interface PaymentLedgerRow {
  paymentType: string;
  status: string;
  amountMinor: number;
}

/**
 * What an order's payment rows say it received and gave back. Money given
 * back is recorded two ways, and both count the same: a refund row
 * (`payment_type = 'refund'`, `refunded`), and a gift-card tender whose hold
 * was released by flipping its own row `succeeded -> refunded` (received,
 * then returned). Pending, authorized, failed and cancelled rows hold no money.
 */
export interface PaymentLedgerTotals {
  receivedMinor: number;
  returnedMinor: number;
}

export function paymentLedgerTotals(payments: readonly PaymentLedgerRow[]): PaymentLedgerTotals {
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
  return { receivedMinor, returnedMinor };
}

/**
 * The same totals as `paymentLedgerTotals`, summed in SQL for one order (the
 * order id is bound as a value), so a writer reads them with the order row in
 * one statement, under the version its CAS then pins.
 */
export function paymentLedgerTotalsSql(orderId: string): { receivedMinor: SQL<number>; returnedMinor: SQL<number> } {
  const sum = (expression: SQL) => sql<number>`(SELECT coalesce(sum(${expression}), 0) FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})`.mapWith(Number);
  return {
    receivedMinor: sum(sql`CASE WHEN ${orderPayments.paymentType} <> 'refund' AND ${orderPayments.status} IN (${PaymentRecordStatus.SUCCEEDED}, ${PaymentRecordStatus.REFUNDED}) THEN ${orderPayments.amountMinor} ELSE 0 END`),
    returnedMinor: sum(sql`CASE WHEN ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED} THEN ${orderPayments.amountMinor} ELSE 0 END`),
  };
}

/** The totals once one more payment of `amountMinor` is received. */
export function withReceived(totals: PaymentLedgerTotals, amountMinor: number): PaymentLedgerTotals {
  return { receivedMinor: totals.receivedMinor + amountMinor, returnedMinor: totals.returnedMinor };
}

function owed(totalAmountMinor: number, paidAmountMinor: number): OrderPaymentState {
  const paid = Math.max(0, paidAmountMinor);
  const balanceDueMinor = Math.max(0, totalAmountMinor - paid);
  const paymentStatus = paid <= 0 ? PaymentStatus.UNPAID : balanceDueMinor === 0 ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
  return { isFullRefund: false, paidAmountMinor: paid, balanceDueMinor, paymentStatus };
}

/**
 * The order's `paid_amount_minor`, `balance_due_minor` and `payment_status`,
 * computed from its payment rows: the one computation every writer uses (a
 * payment landing, cash collected, a recorded payment, a refund settling, a
 * gift-card hold given back). Payment status is a projection of the ledger,
 * never a transition.
 *
 * - Nothing given back: unpaid, partial or paid by what was received.
 * - Everything received given back: refunded, nothing paid, nothing owed.
 * - Money given back from an order that received its total: what it keeps
 *   still covers the total (an over-payment returned) reads paid; otherwise
 *   partially refunded, and the buyer owes nothing more.
 * - Money given back from an order that never received its total (a deposit,
 *   a part-paid invoice): what it keeps is paid and the rest is still owed.
 */
export function deriveOrderPaymentState(input: {
  totalAmountMinor: number;
  /** An invoice (net terms) order: money it was never paid stays owed after a refund. */
  deferred?: boolean;
  /** The order's payment rows, or their totals (`paymentLedgerTotals`, `paymentLedgerTotalsSql`). */
  ledger: readonly PaymentLedgerRow[] | PaymentLedgerTotals;
}): OrderPaymentState {
  const totalAmountMinor = Math.max(0, input.totalAmountMinor);
  const { receivedMinor, returnedMinor } = "receivedMinor" in input.ledger
    ? input.ledger
    : paymentLedgerTotals(input.ledger);
  const keptMinor = Math.max(0, receivedMinor - returnedMinor);
  if (returnedMinor <= 0) return owed(totalAmountMinor, keptMinor);
  // A part-paid invoice keeps owing the rest, even when all it received went back.
  if (input.deferred === true && receivedMinor < totalAmountMinor) return owed(totalAmountMinor, keptMinor);
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

