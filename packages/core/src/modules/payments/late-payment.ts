// Money that arrives for an order that can no longer take it (cancelled,
// archived, returned, refunded, or already paid by another session) is never
// dropped and never left in a manual queue: `processPaymentConfirmed` records
// it against the order as received (its row marked late), and this refunds
// it through the ordinary refund path, exactly once: the refund's request key
// is fixed by the payment row, so a retried event replays the same refund,
// and the provider call carries the refund's own idempotency key. The refund
// writes the order's `refund_recorded` line (reason `late_payment`) and the
// buyer's notice with its money, like any refund.
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { notificationOutbox, orderPayments, orders, refundAttempts } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { ACTIVE_REFUND_ATTEMPT_STATUSES } from "../order-kernel";
import { createOrderNotificationOutboxInsertValues } from "../notifications";
import { paymentProvidersFor, type PaymentProvidersSource } from "./gateways/registry";
import { LATE_PAYMENT_METADATA_KEY, latePaymentEventStatement, latePaymentOf } from "./process-payment";
import { processRefund, refundNotificationOutboxId, type RefundResult } from "./refund-service";

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
  | { status: "pending" }
  /**
   * It cannot be refunded automatically (the provider has no refund, is not
   * configured, or refused it): staff must return the money. The order's
   * timeline says so, and the buyer's `refund_failed` notice (which also
   * reaches staff) is queued: `notificationOutboxId`.
   */
  | { status: "manual"; reason: string; notificationOutboxId: string };

/**
 * Refund one late payment in full, exactly once. A refund that cannot be
 * made is never reported as made: it ends `manual` (see the outcome). A
 * transient failure (another refund holds the order, a database error)
 * throws: the caller retries, and a retry replays the same refund.
 */
export async function refundLatePayment(
  db: Database,
  input: { orderId: string; paymentId: string },
  deps: { encryptionKey: string | undefined; providers: PaymentProvidersSource },
): Promise<LatePaymentRefundOutcome> {
  const payment = await db.select({
    amountMinor: orderPayments.amountMinor,
    currency: orderPayments.currency,
    paymentMethod: orderPayments.paymentMethod,
    metadata: orderPayments.metadata,
  }).from(orderPayments).where(and(eq(orderPayments.id, input.paymentId), eq(orderPayments.orderId, input.orderId))).get();
  if (!payment || !latePaymentOf(payment.metadata)) {
    throw new Error(`Payment ${input.paymentId} is not a late payment of order ${input.orderId}`);
  }
  // `permanent`: the provider has no refund at all; otherwise the failure may heal.
  const manual = (reason: string, permanent = false) => putLateRefundBeforeStaff(db, { ...input, ...payment, reason, permanent });
  // Already put before staff: theirs to finish (through the provider or by hand), never sent again automatically.
  const marked = latePaymentOf(payment.metadata)?.refund;
  if (marked) return manual("This payment is left for staff to return.", marked === "manual");
  const gateway = (await paymentProvidersFor(deps.providers, payment.paymentMethod)).get(payment.paymentMethod);
  if (!gateway?.refund) return manual(`${gateway?.label ?? payment.paymentMethod} cannot refund payments`, true);
  let result: RefundResult;
  try {
    result = await processRefund(db, {
      orderId: input.orderId,
      amountMinor: payment.amountMinor,
      gateway: payment.paymentMethod,
      sourcePaymentId: input.paymentId,
      reason: LATE_PAYMENT_REFUND_REASON,
      requestKey: latePaymentRefundKey(input.paymentId),
    }, deps.encryptionKey, deps.providers);
  } catch (error: unknown) {
    const attempt = await latestRefundAttempt(db, input.paymentId);
    // Sent with an unknown outcome: the attempt stays claimed and reconciliation settles it.
    if (attempt && (ACTIVE_REFUND_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)) return { status: "pending" };
    // It was tried and ended failed (rejected, not configured, never sent): staff return the money.
    if (attempt?.status === "failed") return manual(attempt.lastError ?? (error instanceof Error ? error.message : "The refund failed"));
    if (error instanceof ValidationError) return manual(error.message);
    throw error;
  }
  // A replay of a refund that failed is not a refund.
  if (!result.success) return manual(result.error ?? "The refund failed");
  return { status: "refunded", result };
}

async function latestRefundAttempt(db: Database, paymentId: string) {
  return db.select({ status: refundAttempts.status, lastError: refundAttempts.lastError }).from(refundAttempts)
    .where(eq(refundAttempts.sourcePaymentId, paymentId))
    .orderBy(desc(refundAttempts.createdAt), desc(refundAttempts.id))
    .limit(1)
    .get();
}

/**
 * The late payment could not be refunded automatically: in one batch, the
 * order's `late_payment` line says so (staff refund it by hand) and the
 * buyer's `refund_failed` notice is queued (it reaches staff as well). Once
 * per payment, whatever the retries.
 */
async function putLateRefundBeforeStaff(
  db: Database,
  input: { orderId: string; paymentId: string; amountMinor: number; currency: string; paymentMethod: string; metadata: string | null; reason: string; permanent: boolean },
): Promise<LatePaymentRefundOutcome> {
  const decimals = getDecimalPlaces(input.currency);
  const amount = fromMinor(input.amountMinor, decimals);
  const dedupeKey = `late-payment-refund-failed:${input.paymentId}`;
  const notificationOutboxId = await refundNotificationOutboxId(dedupeKey);
  const { statement: line } = await latePaymentEventStatement(db, {
    orderId: input.orderId,
    paymentId: input.paymentId,
    refund: "failed",
    data: { amount, provider: input.paymentMethod, reason: input.reason.slice(0, 300) },
    when: sql`1 = 1`,
  });
  // The payment is marked for staff: `manual` when its provider cannot refund
  // at all (a hand return), `retry` when the failure may heal (the provider
  // stays the default; returning it by hand is a decision staff record). An
  // order the sweep archived comes back into view: money the store must
  // return is never hidden (orders list view `money_to_return`).
  const metadata = JSON.parse(input.metadata ?? "{}") as Record<string, Record<string, unknown>>;
  metadata[LATE_PAYMENT_METADATA_KEY] = { ...metadata[LATE_PAYMENT_METADATA_KEY], refund: input.permanent ? "manual" : "retry" };
  await db.batch([
    db.update(orderPayments).set({ metadata: JSON.stringify(metadata), updatedAt: sql`unixepoch()` })
      .where(eq(orderPayments.id, input.paymentId)),
    db.update(orders).set({ deletedAt: null, version: sql`${orders.version} + 1`, updatedAt: sql`unixepoch()` })
      .where(and(eq(orders.id, input.orderId), isNotNull(orders.deletedAt))),
    line,
    db.insert(notificationOutbox).values({
      ...createOrderNotificationOutboxInsertValues({
        orderId: input.orderId,
        notificationType: "refund_failed",
        dedupeKey,
        source: "late-payment",
        data: { amount },
      }),
      id: notificationOutboxId,
    }).onConflictDoNothing({ target: notificationOutbox.dedupeKey }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
  ] as any);
  return { status: "manual", reason: input.reason, notificationOutboxId };
}
