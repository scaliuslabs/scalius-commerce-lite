// src/modules/payments/cod.ts
// Cash on Delivery (COD) tracking and management.
// No external gateway — tracks delivery attempts and cash collection in DB.

import { and, eq, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  codTracking,
  CodStatus,
  orders,
  orderPayments,
  paymentPlans,
  PaymentMethod,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import type {
  InitCODTrackingParams,
  RecordCODCollectionParams,
  RecordCODFailureParams,
} from "./types";
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
} from "./provider";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { computePaymentStateAfterPayment } from "./payment-state";
import {
  assertOrderPaymentCurrency,
  orderMoneyEqual,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
} from "./order-currency";

interface CodCollectionOrderSnapshot {
  totalAmount: number;
  paidAmount: number | null;
  balanceDue: number | null;
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
}

interface NormalizedCodCollection {
  collectedBy: string;
  collectedAmount: number;
  expectedAmount: number;
  newPaidAmount: number;
  newBalanceDue: number;
}

const COD_COLLECTION_BATCH_GUARD = "COD_COLLECTION_STATE_CHANGED";
type SQLiteBatchItem = BatchItem<"sqlite">;

function codCollectionPaymentId(orderId: string): string {
  return `cod_collection:${orderId}`;
}

export function validateCODCollectionDetails(
  order: CodCollectionOrderSnapshot,
  params: Pick<RecordCODCollectionParams, "collectedBy" | "collectedAmount">,
): NormalizedCodCollection {
  const currency = resolveOrderCurrencySnapshot(order);
  if (typeof params.collectedBy !== "string") {
    throw new ValidationError("Collector name is required for COD collection.");
  }

  const collectedBy = params.collectedBy.trim();
  if (!collectedBy) {
    throw new ValidationError("Collector name is required for COD collection.");
  }

  if (!Number.isFinite(params.collectedAmount) || params.collectedAmount <= 0) {
    throw new ValidationError("COD collected amount must be a positive finite number.");
  }

  const currentPaidAmount = roundOrderMoney(order.paidAmount ?? 0, currency);
  const computedBalanceDue = roundOrderMoney(Math.max(0, order.totalAmount - currentPaidAmount), currency);
  const storedBalanceDue = Number.isFinite(order.balanceDue)
    ? roundOrderMoney(Number(order.balanceDue), currency)
    : null;
  const expectedAmount = roundOrderMoney(Math.max(
    0,
    storedBalanceDue !== null && orderMoneyEqual(storedBalanceDue, computedBalanceDue, currency)
      ? storedBalanceDue
      : computedBalanceDue,
  ), currency);
  const collectedAmount = roundOrderMoney(params.collectedAmount, currency);

  if (expectedAmount <= 0) {
    throw new ValidationError("This order has no outstanding COD balance to collect.");
  }

  if (!orderMoneyEqual(collectedAmount, expectedAmount, currency)) {
    throw new ValidationError(
      `COD collected amount must match the outstanding balance (${expectedAmount}).`,
      { expectedAmount, collectedAmount },
    );
  }

  const newPaidAmount = roundOrderMoney(currentPaidAmount + collectedAmount, currency);
  const newBalanceDue = computePaymentStateAfterPayment({
    totalAmount: order.totalAmount,
    currentPaidAmount,
    paymentAmount: collectedAmount,
    currency,
  }).balanceDue;

  return {
    collectedBy,
    collectedAmount,
    expectedAmount,
    newPaidAmount,
    newBalanceDue,
  };
}

/**
 * Canonical initial COD authority. Order-creation paths use these values in
 * the same D1 batch as the order row so a committed COD order can never exist
 * without its collection lifecycle record.
 */
export function createCODTrackingInsertValues(orderId: string) {
  return {
    id: crypto.randomUUID(),
    orderId,
    deliveryAttempts: 0,
    codStatus: "pending" as const,
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  };
}

/**
 * Create a COD tracking record when a COD order is placed.
 * Called during order creation.
 */
export async function initCODTracking(
  db: Database,
  params: InitCODTrackingParams
): Promise<void> {
  await db
    .insert(codTracking)
    .values(createCODTrackingInsertValues(params.orderId))
    .onConflictDoNothing({ target: codTracking.orderId });
}

/**
 * Record a successful COD collection by a courier.
 * Updates: codTracking, orderPayments, and orders.paymentStatus.
 */
export async function recordCODCollection(
  db: Database,
  params: RecordCODCollectionParams
): Promise<{ success: boolean; error?: string }> {
  try {
    const order = await db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        version: orders.version,
        deletedAt: orders.deletedAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!order) {
      throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    const currency = resolveOrderCurrencySnapshot(order);
    const paymentPlan = await db
      .select({
        id: paymentPlans.id,
        status: paymentPlans.status,
        balanceDue: paymentPlans.balanceDue,
      })
      .from(paymentPlans)
      .where(eq(paymentPlans.orderId, params.orderId))
      .get();

    // A successful COD row is the durable idempotency claim for both a full
    // COD order and the cash balance of an advance-payment plan.
    const existingPayment = await db
      .select({
        id: orderPayments.id,
        amount: orderPayments.amount,
        currency: orderPayments.currency,
        paymentType: orderPayments.paymentType,
        codCollectedBy: orderPayments.codCollectedBy,
      })
      .from(orderPayments)
      .where(
        and(
          eq(orderPayments.orderId, params.orderId),
          eq(orderPayments.paymentMethod, PaymentMethod.COD),
          eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
        ),
      )
      .get();
    const tracking = await db
      .select({
        id: codTracking.id,
        codStatus: codTracking.codStatus,
        collectedBy: codTracking.collectedBy,
        collectedAmount: codTracking.collectedAmount,
      })
      .from(codTracking)
      .where(eq(codTracking.orderId, params.orderId))
      .get();

    if (existingPayment) {
      assertOrderPaymentCurrency(existingPayment.currency, currency, "Existing COD payment");
      const collectedAmount = roundOrderMoney(params.collectedAmount, currency);
      if (!Number.isFinite(params.collectedAmount) || params.collectedAmount <= 0) {
        throw new ValidationError("COD collected amount must be a positive finite number.");
      }
      if (!orderMoneyEqual(existingPayment.amount, collectedAmount, currency)) {
        throw new ValidationError("COD collection was already recorded with a different amount.", {
          recordedAmount: existingPayment.amount,
          collectedAmount,
        });
      }
      const collectedBy = typeof params.collectedBy === "string"
        ? params.collectedBy.trim()
        : "";
      if (!collectedBy) {
        throw new ValidationError("Collector name is required for COD collection.");
      }
      const expectedPaymentType = paymentPlan ? "balance" : "full";
      const hasCompleteEvidence =
        existingPayment.paymentType === expectedPaymentType &&
        existingPayment.codCollectedBy === collectedBy &&
        tracking?.codStatus === CodStatus.COLLECTED &&
        tracking.collectedBy === collectedBy &&
        tracking.collectedAmount !== null &&
        orderMoneyEqual(tracking.collectedAmount, collectedAmount, currency) &&
        order.paymentStatus === PaymentStatus.PAID &&
        orderMoneyEqual(order.paidAmount ?? 0, order.totalAmount, currency) &&
        orderMoneyEqual(order.balanceDue ?? 0, 0, currency) &&
        (!paymentPlan || paymentPlan.status === PaymentPlanStatus.COMPLETED);
      if (!hasCompleteEvidence) {
        throw new ValidationError(
          "Cash collection evidence is incomplete or conflicts with the saved order. Review the payment before retrying.",
        );
      }
      return { success: true }; // Already recorded — idempotent
    }

    if (tracking?.codStatus === CodStatus.COLLECTED) {
      throw new ValidationError(
        "Cash collection tracking exists without a successful payment record. Review the payment before retrying.",
      );
    }

    const collection = validateCODCollectionDetails(order, params);
    const isBalanceCollection = Boolean(paymentPlan);
    if (paymentPlan) {
      if (paymentPlan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
        throw new ValidationError(
          "The online deposit must be paid before collecting the cash balance on delivery.",
        );
      }
      if (!orderMoneyEqual(paymentPlan.balanceDue, collection.collectedAmount, currency)) {
        throw new ValidationError(
          "Cash collected must match the remaining balance in the payment plan.",
          {
            expectedAmount: roundOrderMoney(paymentPlan.balanceDue, currency),
            collectedAmount: collection.collectedAmount,
          },
        );
      }
    } else if (order.paymentMethod !== PaymentMethod.COD) {
      throw new ValidationError(
        "Cash collection is available only for cash-on-delivery orders or a paid-deposit balance.",
      );
    }

    const paymentId = codCollectionPaymentId(params.orderId);
    const nextVersion = order.version + 1;
    const paymentType = isBalanceCollection ? "balance" : "full";
    const planReadyCondition = isBalanceCollection
      ? sql`EXISTS (
          SELECT 1 FROM ${paymentPlans}
          WHERE ${paymentPlans.orderId} = ${params.orderId}
            AND ${paymentPlans.status} = ${PaymentPlanStatus.DEPOSIT_PAID}
            AND round(${paymentPlans.balanceDue}, ${currency.decimalPlaces}) = round(${collection.collectedAmount}, ${currency.decimalPlaces})
        )`
      : sql`1 = 1`;

    // The deterministic payment id is the concurrency claim. The final guard
    // verifies the whole aggregate and aborts the provider-neutral batch if a
    // stale order version or plan status caused any write to become a no-op.
    const batchStatements: SQLiteBatchItem[] = [
      db
        .insert(codTracking)
        .values(createCODTrackingInsertValues(params.orderId))
        .onConflictDoNothing({ target: codTracking.orderId }),

      db
        .update(orders)
        .set({
          paymentStatus: PaymentStatus.PAID,
          paidAmount: collection.newPaidAmount,
          balanceDue: collection.newBalanceDue,
          version: nextVersion,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(orders.id, params.orderId),
          eq(orders.version, order.version),
          eq(orders.paymentStatus, order.paymentStatus),
          sql`round(${orders.paidAmount}, ${currency.decimalPlaces}) = round(${order.paidAmount ?? 0}, ${currency.decimalPlaces})`,
          sql`round(${orders.balanceDue}, ${currency.decimalPlaces}) = round(${order.balanceDue ?? 0}, ${currency.decimalPlaces})`,
          sql`${orders.deletedAt} IS NULL`,
          planReadyCondition,
        ))
        .returning({ id: orders.id }),

      db
        .insert(orderPayments)
        .values({
          id: paymentId,
          orderId: params.orderId,
          amount: collection.collectedAmount,
          currency: currency.code,
          paymentMethod: PaymentMethod.COD,
          paymentType,
          status: PaymentRecordStatus.SUCCEEDED,
          codCollectedBy: collection.collectedBy,
          codCollectedAt: sql`unixepoch()`,
          codReceiptUrl: params.receiptUrl ?? null,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .onConflictDoNothing({ target: orderPayments.id }),

      db
        .update(codTracking)
        .set({
          codStatus: CodStatus.COLLECTED,
          collectedBy: collection.collectedBy,
          collectedAmount: collection.collectedAmount,
          collectedAt: sql`unixepoch()`,
          receiptUrl: params.receiptUrl ?? null,
          deliveryAttempts: sql`${codTracking.deliveryAttempts} + 1`,
          lastAttemptAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(codTracking.orderId, params.orderId),
          ne(codTracking.codStatus, CodStatus.COLLECTED),
          sql`EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.id} = ${paymentId}
              AND ${orderPayments.orderId} = ${params.orderId}
          )`,
        ))
        .returning({ id: codTracking.id }),
    ];

    if (isBalanceCollection) {
      batchStatements.push(
        db
          .update(paymentPlans)
          .set({
            status: PaymentPlanStatus.COMPLETED,
            balancePaidAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
          })
          .where(and(
            eq(paymentPlans.orderId, params.orderId),
            eq(paymentPlans.status, PaymentPlanStatus.DEPOSIT_PAID),
            sql`EXISTS (
              SELECT 1 FROM ${orderPayments}
              WHERE ${orderPayments.id} = ${paymentId}
                AND ${orderPayments.orderId} = ${params.orderId}
            )`,
          ))
          .returning({ id: paymentPlans.id }),
      );
    }

    const completedPlanCondition = isBalanceCollection
      ? sql`EXISTS (
          SELECT 1 FROM ${paymentPlans}
          WHERE ${paymentPlans.orderId} = ${params.orderId}
            AND ${paymentPlans.status} = ${PaymentPlanStatus.COMPLETED}
            AND ${paymentPlans.balancePaidAt} IS NOT NULL
        )`
      : sql`1 = 1`;
    batchStatements.push(buildBatchGuard(db, sql`
      EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${params.orderId}
          AND ${orders.version} = ${nextVersion}
          AND ${orders.paymentStatus} = ${PaymentStatus.PAID}
          AND round(${orders.paidAmount}, ${currency.decimalPlaces}) = round(${collection.newPaidAmount}, ${currency.decimalPlaces})
          AND round(${orders.balanceDue}, ${currency.decimalPlaces}) = 0
      )
      AND EXISTS (
        SELECT 1 FROM ${orderPayments}
        WHERE ${orderPayments.id} = ${paymentId}
          AND ${orderPayments.orderId} = ${params.orderId}
          AND ${orderPayments.paymentMethod} = ${PaymentMethod.COD}
          AND ${orderPayments.paymentType} = ${paymentType}
          AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
          AND ${orderPayments.currency} = ${currency.code}
          AND ${orderPayments.codCollectedBy} = ${collection.collectedBy}
          AND round(${orderPayments.amount}, ${currency.decimalPlaces}) = round(${collection.collectedAmount}, ${currency.decimalPlaces})
      )
      AND EXISTS (
        SELECT 1 FROM ${codTracking}
        WHERE ${codTracking.orderId} = ${params.orderId}
          AND ${codTracking.codStatus} = ${CodStatus.COLLECTED}
          AND ${codTracking.collectedBy} = ${collection.collectedBy}
          AND round(${codTracking.collectedAmount}, ${currency.decimalPlaces}) = round(${collection.collectedAmount}, ${currency.decimalPlaces})
      )
      AND ${completedPlanCondition}
    `, COD_COLLECTION_BATCH_GUARD));

    await safeBatch(db, batchStatements as never);

    return { success: true };
  } catch (err: unknown) {
    // Re-throw typed errors so the API layer can handle them
    if (err instanceof NotFoundError || err instanceof ValidationError || err instanceof ConflictError) throw err;
    if (isBatchGuardError(err, COD_COLLECTION_BATCH_GUARD)) {
      throw new ConflictError("Order payment changed while cash collection was being recorded. Reload and try again.");
    }
    const message = err instanceof Error ? err.message : "Failed to record COD collection";
    return { success: false, error: message };
  }
}

/**
 * Record a failed COD delivery attempt.
 * Increments the attempt counter and logs the failure reason.
 */
export async function recordCODFailure(
  db: Database,
  params: RecordCODFailureParams
): Promise<{ success: boolean; error?: string }> {
  try {
    await db
      .update(codTracking)
      .set({
        codStatus: "failed",
        failureReason: params.reason,
        deliveryAttempts: sql`${codTracking.deliveryAttempts} + 1`,
        lastAttemptAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, params.orderId));

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to record COD failure";
    return { success: false, error: message };
  }
}

/**
 * Mark a COD order as returned to merchant (all delivery attempts exhausted).
 */
export async function markCODReturned(
  db: Database,
  orderId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await db
      .update(codTracking)
      .set({
        codStatus: "returned",
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, orderId))
      .returning({ id: codTracking.id });

    if (result.length === 0) {
      throw new ValidationError("COD tracking record is missing for this order.");
    }

    return { success: true };
  } catch (err: unknown) {
    if (err instanceof ValidationError) throw err;
    const message = err instanceof Error ? err.message : "Failed to mark COD as returned";
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// PaymentProvider implementation
// ---------------------------------------------------------------------------

/**
 * COD PaymentProvider implementation.
 *
 * COD is fundamentally different from online gateways — there's no external
 * payment session to create and no webhooks. The "payment" is the physical
 * cash collection that happens at delivery time. This provider creates a
 * COD tracking record when `createPayment` is called, and COD "refunds"
 * are just status markers (no gateway API call).
 */
export class CODProvider implements PaymentProvider {
  readonly type = "cod" as const;
  readonly name = "Cash on Delivery";

  constructor(private readonly db: Database) {}

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    await initCODTracking(this.db, { orderId: params.orderId });

    return {
      transactionId: `COD-${params.orderId}`,
      // No clientSecret or redirectUrl — COD requires no online payment action
    };
  }

  async createRefund(_params: RefundParams): Promise<RefundResult> {
    // COD "refund" is a status update only — no external gateway call.
    // The actual cash refund is handled operationally (manual process).
    return {
      refundId: `COD-REFUND-${Date.now()}`,
    };
  }

  // COD has no webhooks — verifyWebhook is intentionally not implemented
}
