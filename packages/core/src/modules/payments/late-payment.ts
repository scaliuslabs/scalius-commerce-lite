// Money that arrives for an order that can no longer take it (cancelled,
// archived, returned, refunded, or already paid by another session) is never
// dropped and never left in a manual queue: `processPaymentConfirmed` records
// it against the order as received (its row marked late), and this refunds
// it through the ordinary refund path, exactly once: the refund's request key
// is fixed by the payment row, so a retried event replays the same refund,
// and the provider call carries the refund's own idempotency key. The refund
// writes the order's `refund_recorded` line (reason `late_payment`) and the
// buyer's notice with its money, like any refund.
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orderPayments, refundAttempts } from "@scalius/database/schema";
import { ACTIVE_REFUND_ATTEMPT_STATUSES } from "../order-kernel";
import type { PaymentProvidersSource } from "./gateways/registry";
import { latePaymentOf } from "./process-payment";
import { processRefund, type RefundResult } from "./refund-service";

/** The refund reason of an automatic late-payment refund (the dashboard words it). */
export const LATE_PAYMENT_REFUND_REASON = "late_payment";

/** The refund request key of one late payment: one refund per payment row, ever. */
export function latePaymentRefundKey(paymentId: string): string {
  return `late-payment:${paymentId}`;
}

export type LatePaymentRefundOutcome =
  /** The money went back (or had already). */
  | { status: "refunded"; result: RefundResult }
  /** Sent, and its outcome is being reconciled: reconciliation finishes it. */
  | { status: "pending" };

/**
 * Refund one late payment in full. Throws when nothing is in flight and the
 * refund could not be made (the provider refused it, another refund holds
 * the order): the caller retries later, and a retry replays the same refund.
 */
export async function refundLatePayment(
  db: Database,
  input: { orderId: string; paymentId: string },
  deps: { encryptionKey: string | undefined; providers: PaymentProvidersSource },
): Promise<LatePaymentRefundOutcome> {
  const payment = await db.select({
    amountMinor: orderPayments.amountMinor,
    paymentMethod: orderPayments.paymentMethod,
    metadata: orderPayments.metadata,
  }).from(orderPayments).where(and(eq(orderPayments.id, input.paymentId), eq(orderPayments.orderId, input.orderId))).get();
  if (!payment || !latePaymentOf(payment.metadata)) {
    throw new Error(`Payment ${input.paymentId} is not a late payment of order ${input.orderId}`);
  }
  try {
    const result = await processRefund(db, {
      orderId: input.orderId,
      amountMinor: payment.amountMinor,
      gateway: payment.paymentMethod,
      sourcePaymentId: input.paymentId,
      reason: LATE_PAYMENT_REFUND_REASON,
      requestKey: latePaymentRefundKey(input.paymentId),
    }, deps.encryptionKey, deps.providers);
    return { status: "refunded", result };
  } catch (error: unknown) {
    // Sent with an unknown outcome: the attempt stays claimed and reconciliation settles it.
    const inFlight = await db.select({ id: refundAttempts.id }).from(refundAttempts).where(and(
      eq(refundAttempts.sourcePaymentId, input.paymentId),
      inArray(refundAttempts.status, [...ACTIVE_REFUND_ATTEMPT_STATUSES]),
    )).get();
    if (inFlight) return { status: "pending" };
    throw error;
  }
}
