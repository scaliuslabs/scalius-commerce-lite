// src/modules/payments/cod.ts
// Cash on Delivery (COD) tracking and management.
// No external gateway — tracks delivery attempts and cash collection in DB.

import { and, eq, ne, notInArray, sql } from "drizzle-orm";
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
  RecordCODCollectionParams,
  RecordCODFailureParams,
} from "./types";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { cashOnDeliveryIncrementMinor } from "@scalius/shared/currency-policy";
import { presentedSettlement } from "@scalius/shared/money-chain";
import { fromMinor, PriceIncrementError, toIncrementMinor } from "@scalius/shared/money";
import { deriveOrderPaymentState, ledgerTotalsCondition, paymentLedgerTotalsSql, withReceived } from "./payment-state";
import { closedOrderPaymentReason, PAYMENT_BLOCKED_ORDER_STATUSES } from "./payable-order";
import { assertOrderPaymentCurrency, resolveOrderCurrencySnapshot } from "./order-currency";
import { formatAmount, moneyLocale } from "@scalius/shared/money-format";

interface CodCollectionOrderSnapshot {
  totalAmountMinor: number;
  paidAmountMinor: number;
  balanceDueMinor: number;
  currencyCode: string;
  currencyDecimalPlaces: number;
}

interface NormalizedCodCollection {
  collectedBy: string;
  collectedAmountMinor: number;
}

const COD_COLLECTION_BATCH_GUARD = "cod_collection_state_changed";
type SQLiteBatchItem = BatchItem<"sqlite">;

function codCollectionPaymentId(orderId: string): string {
  return `cod_collection:${orderId}`;
}

function assertPositiveMinor(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError("COD collected amount must be a positive finite number.");
  }
}

/** Money for a merchant-facing sentence: "৳2,480" / "৳1,234.50" (lakh grouping for taka). */
function formatOrderMoney(amountMinor: number, currency: { code: string; decimalPlaces: number }): string {
  const number = formatAmount(fromMinor(amountMinor, currency.decimalPlaces), moneyLocale(currency.code), currency.decimalPlaces, true);
  return currency.code === "BDT" ? `৳${number}` : `${currency.code} ${number}`;
}

/**
 * Cash a rider or the counter collected, or a parcel's amount to collect,
 * entered in decimal major units: minor units on the cash increment cash on
 * delivery collects (`cashOnDeliveryIncrementMinor`: whole taka in BDT).
 */
export function toCashOnDeliveryMinor(amount: number, currency: { code: string; decimalPlaces: number }): number {
  try {
    return toIncrementMinor(amount, currency.decimalPlaces, cashOnDeliveryIncrementMinor(currency.code), currency.code);
  } catch (error) {
    if (error instanceof PriceIncrementError) throw new ValidationError(error.message);
    throw error;
  }
}

export function validateCODCollectionDetails(
  order: CodCollectionOrderSnapshot,
  params: Pick<RecordCODCollectionParams, "collectedBy" | "collectedAmountMinor">,
): NormalizedCodCollection {
  const currency = resolveOrderCurrencySnapshot(order);
  if (typeof params.collectedBy !== "string") {
    throw new ValidationError("Enter who collected the cash.");
  }

  const collectedBy = params.collectedBy.trim();
  if (!collectedBy) {
    throw new ValidationError("Enter who collected the cash.");
  }

  assertPositiveMinor(params.collectedAmountMinor);

  const expectedAmountMinor = Math.max(0, order.totalAmountMinor - order.paidAmountMinor);
  if (expectedAmountMinor <= 0) {
    throw new ValidationError("This order has no outstanding COD balance to collect.");
  }
  if (params.collectedAmountMinor !== expectedAmountMinor) {
    const expectedAmount = fromMinor(expectedAmountMinor, currency.decimalPlaces);
    throw new ValidationError(
      `Record the full cash balance of ${formatOrderMoney(expectedAmountMinor, currency)}.`,
      { expectedAmount, collectedAmount: fromMinor(params.collectedAmountMinor, currency.decimalPlaces) },
    );
  }

  return { collectedBy, collectedAmountMinor: params.collectedAmountMinor };
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

/** A cash collection prepared for the caller's own batch (`prepareCODCollection`). */
export type PreparedCODCollection =
  /** The same collection is already recorded in full: nothing to write. */
  | { alreadyRecorded: true }
  | {
    alreadyRecorded: false;
    /** The tracking, order, payment and plan writes, ending with the guard that aborts the batch on a stale order. */
    statements: SQLiteBatchItem[];
    /** The order version the batch leaves (one above the version it read). */
    nextVersion: number;
  };

/** The batch of a prepared collection aborted: the order's payment changed since it was read. */
export function isCODCollectionConflictError(error: unknown): boolean {
  return isBatchGuardError(error, COD_COLLECTION_BATCH_GUARD);
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
    const prepared = await prepareCODCollection(db, params);
    if (!prepared.alreadyRecorded) await safeBatch(db, prepared.statements as never);
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
 * The writes of `recordCODCollection`, without sending them: reads and checks
 * only, so a caller commits the cash record in the same batch as what depends
 * on it (a delivered status, its stock, timeline line and customer message).
 * Throws the same typed errors.
 */
export async function prepareCODCollection(
  db: Database,
  params: RecordCODCollectionParams,
): Promise<PreparedCODCollection> {
  {
    const order = await db
      .select({
        id: orders.id,
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        status: orders.status,
        version: orders.version,
        deletedAt: orders.deletedAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        paymentTermsDays: orders.paymentTermsDays,
        // The payment ledger, read with the row the write's CAS pins.
        ...paymentLedgerTotalsSql(params.orderId),
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!order) {
      throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    // Cash is never recorded as paid on an order that was cancelled,
    // returned or refunded: the money owed there is closed.
    const closedReason = closedOrderPaymentReason(order);
    if (closedReason) throw new ValidationError(closedReason);
    const currency = resolveOrderCurrencySnapshot(order);
    const paymentPlan = await db
      .select({
        id: paymentPlans.id,
        status: paymentPlans.status,
        balanceDueMinor: paymentPlans.balanceDueMinor,
      })
      .from(paymentPlans)
      .where(eq(paymentPlans.orderId, params.orderId))
      .get();

    // A successful COD row is the durable idempotency claim for both a full
    // COD order and the cash balance of an advance-payment plan.
    const existingPayment = await db
      .select({
        id: orderPayments.id,
        amountMinor: orderPayments.amountMinor,
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
        collectedAmountMinor: codTracking.collectedAmountMinor,
      })
      .from(codTracking)
      .where(eq(codTracking.orderId, params.orderId))
      .get();

    if (existingPayment) {
      assertOrderPaymentCurrency(existingPayment.currency, currency, "Existing COD payment");
      const collectedAmountMinor = params.collectedAmountMinor;
      assertPositiveMinor(collectedAmountMinor);
      if (existingPayment.amountMinor !== collectedAmountMinor) {
        throw new ValidationError("COD collection was already recorded with a different amount.", {
          recordedAmount: fromMinor(existingPayment.amountMinor, currency.decimalPlaces),
          collectedAmount: fromMinor(collectedAmountMinor, currency.decimalPlaces),
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
        tracking.collectedAmountMinor === collectedAmountMinor &&
        order.paymentStatus === PaymentStatus.PAID &&
        order.paidAmountMinor === order.totalAmountMinor &&
        order.balanceDueMinor === 0 &&
        (!paymentPlan || paymentPlan.status === PaymentPlanStatus.COMPLETED);
      if (!hasCompleteEvidence) {
        throw new ValidationError(
          "Cash collection evidence is incomplete or conflicts with the saved order. Review the payment before retrying.",
        );
      }
      return { alreadyRecorded: true }; // Already recorded — idempotent
    }

    if (tracking?.codStatus === CodStatus.COLLECTED) {
      throw new ValidationError(
        "Cash collection tracking exists without a successful payment record. Review the payment before retrying.",
      );
    }

    const collection = validateCODCollectionDetails(order, params);
    const next = deriveOrderPaymentState({
      totalAmountMinor: order.totalAmountMinor,
      deferred: order.paymentTermsDays !== null,
      ledger: withReceived(order, collection.collectedAmountMinor),
    });
    const isBalanceCollection = Boolean(paymentPlan);
    if (paymentPlan) {
      if (paymentPlan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
        throw new ValidationError(
          "The online deposit must be paid before collecting the cash balance on delivery.",
        );
      }
      if (paymentPlan.balanceDueMinor !== collection.collectedAmountMinor) {
        throw new ValidationError(
          "Cash collected must match the remaining balance in the payment plan.",
          {
            expectedAmount: fromMinor(paymentPlan.balanceDueMinor, currency.decimalPlaces),
            collectedAmount: fromMinor(collection.collectedAmountMinor, currency.decimalPlaces),
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
            AND ${paymentPlans.balanceDueMinor} = ${collection.collectedAmountMinor}
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
          paymentStatus: next.paymentStatus,
          paidAmountMinor: next.paidAmountMinor,
          balanceDueMinor: next.balanceDueMinor,
          version: nextVersion,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(orders.id, params.orderId),
          eq(orders.version, order.version),
          eq(orders.status, order.status),
          notInArray(orders.status, [...PAYMENT_BLOCKED_ORDER_STATUSES]),
          eq(orders.paymentStatus, order.paymentStatus),
          eq(orders.paidAmountMinor, order.paidAmountMinor),
          eq(orders.balanceDueMinor, order.balanceDueMinor),
          sql`${orders.deletedAt} IS NULL`,
          planReadyCondition,
          // The rows the new state counts: as read, the cash not among them yet.
          ledgerTotalsCondition(params.orderId, order),
        ))
        .returning({ id: orders.id }),

      db
        .insert(orderPayments)
        .values({
          id: paymentId,
          orderId: params.orderId,
          amountMinor: collection.collectedAmountMinor,
          currency: currency.code,
          // Cash in hand is settled as collected.
          ...presentedSettlement(collection.collectedAmountMinor, currency.code),
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
          collectedAmountMinor: collection.collectedAmountMinor,
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
          AND ${orders.paymentStatus} = ${next.paymentStatus}
          AND ${orders.paidAmountMinor} = ${next.paidAmountMinor}
          AND ${orders.balanceDueMinor} = ${next.balanceDueMinor}
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
          AND ${orderPayments.amountMinor} = ${collection.collectedAmountMinor}
      )
      AND EXISTS (
        SELECT 1 FROM ${codTracking}
        WHERE ${codTracking.orderId} = ${params.orderId}
          AND ${codTracking.codStatus} = ${CodStatus.COLLECTED}
          AND ${codTracking.collectedBy} = ${collection.collectedBy}
          AND ${codTracking.collectedAmountMinor} = ${collection.collectedAmountMinor}
      )
      AND ${completedPlanCondition}
    `, COD_COLLECTION_BATCH_GUARD));

    return { alreadyRecorded: false, statements: batchStatements, nextVersion };
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
        failureNote: params.notes?.trim() || null,
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
