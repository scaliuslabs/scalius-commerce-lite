// A payment staff or an app records against a deferred (net terms) order: a
// bank transfer, a cheque or cash received for an invoice. No provider is
// called. The payment row (`payment_method` "manual", RECORDED_PAYMENT_METHOD)
// and the order's new paid amount commit in one guarded batch; its insert
// emits `payment.updated` and a fully paid order emits `order.paid` (event
// outbox triggers). A refund of it is a confirmed manual settlement.
//
// Idempotent: the caller's request key names the payment row, so a retry
// returns the first result and a different payment under the same key is
// refused.
import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  orders,
  orderPayments,
  OrderStatus,
  PaymentRecordStatus,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "@scalius/shared/hash";
import { presentedSettlement } from "@scalius/shared/money-chain";
import { RECORDED_PAYMENT_METHOD, RECORDED_PAYMENT_VIAS, type RecordedPaymentVia } from "@scalius/shared/payment-terms";
import { computePaymentStateAfterPayment } from "./payment-state";
import { resolveOrderCurrencySnapshot } from "./order-currency";

type SQLiteBatchItem = BatchItem<"sqlite">;

const RECORDED_PAYMENT_BATCH_GUARD = "RECORDED_PAYMENT_STATE_CHANGED";

export interface RecordOrderPaymentInput {
  orderId: string;
  /** Integer minor units of the order's currency; at most the balance due. */
  amountMinor: number;
  via: RecordedPaymentVia;
  /** The bank or cheque reference, shown to staff. */
  reference?: string | null;
  note?: string | null;
  /** Who recorded it: a staff user id, or the app's id. */
  recordedBy: string;
  /** The caller's retry key (Idempotency-Key): one key, one payment. */
  requestKey: string;
  /** The order version the caller saw; a different one is refused (409) and nothing is recorded. */
  expectedVersion?: number;
}

export interface RecordOrderPaymentResult {
  paymentId: string;
  paymentStatus: string;
  paidAmountMinor: number;
  balanceDueMinor: number;
  /** True when this key had already recorded the payment. */
  replayed: boolean;
}

interface RecordedPaymentMetadata {
  via: RecordedPaymentVia;
  reference: string | null;
  note: string | null;
  recordedBy: string;
}

function trimmed(value: string | null | undefined, max: number): string | null {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
}

async function recordedPaymentId(orderId: string, requestKey: string): Promise<string> {
  return `recorded:${orderId}:${(await sha256Hex(`${orderId}\n${requestKey}`)).slice(0, 32)}`;
}

function readMetadata(value: string | null): Partial<RecordedPaymentMetadata> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Partial<RecordedPaymentMetadata> : {};
  } catch {
    return {};
  }
}

/** Orders a recorded payment can never land on. */
const CLOSED_STATUSES = new Set<string>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);

export async function recordOrderPayment(
  db: Database,
  input: RecordOrderPaymentInput,
): Promise<RecordOrderPaymentResult> {
  if (!(RECORDED_PAYMENT_VIAS as readonly string[]).includes(input.via)) {
    throw new ValidationError("Choose how the payment was received.");
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError("Enter the amount received.");
  }
  const requestKey = input.requestKey.trim();
  if (requestKey.length < 8 || requestKey.length > 200) {
    throw new ValidationError("A retry key of 8 to 200 characters is required.");
  }
  const metadata: RecordedPaymentMetadata = {
    via: input.via,
    reference: trimmed(input.reference, 120),
    note: trimmed(input.note, 500),
    recordedBy: input.recordedBy.slice(0, 160),
  };
  const paymentId = await recordedPaymentId(input.orderId, requestKey);

  const [order, existing] = await Promise.all([
    db.select({
      id: orders.id,
      status: orders.status,
      totalAmountMinor: orders.totalAmountMinor,
      paidAmountMinor: orders.paidAmountMinor,
      balanceDueMinor: orders.balanceDueMinor,
      paymentStatus: orders.paymentStatus,
      paymentTermsDays: orders.paymentTermsDays,
      version: orders.version,
      deletedAt: orders.deletedAt,
      currencyCode: orders.currencyCode,
      currencyDecimalPlaces: orders.currencyDecimalPlaces,
    }).from(orders).where(eq(orders.id, input.orderId)).get(),
    db.select({
      amountMinor: orderPayments.amountMinor,
      status: orderPayments.status,
      metadata: orderPayments.metadata,
    }).from(orderPayments).where(eq(orderPayments.id, paymentId)).get(),
  ]);
  if (!order || order.deletedAt) throw new NotFoundError("Order not found");

  if (existing) {
    const recorded = readMetadata(existing.metadata);
    if (existing.amountMinor !== input.amountMinor || recorded.via !== input.via) {
      throw new ConflictError("This retry key already recorded a different payment.");
    }
    return {
      paymentId,
      paymentStatus: order.paymentStatus,
      paidAmountMinor: order.paidAmountMinor,
      balanceDueMinor: order.balanceDueMinor,
      replayed: true,
    };
  }

  if (input.expectedVersion !== undefined && input.expectedVersion !== order.version) {
    throw new ConflictError("This order changed. Reload it and record the payment again.");
  }
  if (order.paymentTermsDays === null) {
    throw new ValidationError("Payments are recorded here only for invoice (net terms) orders. Record cash on delivery with Collect cash.");
  }
  if (CLOSED_STATUSES.has(order.status)) {
    throw new ValidationError("This order is closed, so no payment can be recorded on it.");
  }
  if (order.balanceDueMinor <= 0) {
    throw new ValidationError("This order has nothing left to pay.");
  }
  if (input.amountMinor > order.balanceDueMinor) {
    throw new ValidationError("The amount is more than the balance due.", {
      balanceDueMinor: order.balanceDueMinor,
    });
  }
  const currency = resolveOrderCurrencySnapshot(order);
  const next = computePaymentStateAfterPayment({
    totalAmountMinor: order.totalAmountMinor,
    currentPaidAmountMinor: order.paidAmountMinor,
    paymentAmountMinor: input.amountMinor,
  });
  const nextVersion = order.version + 1;
  const paymentType = order.paidAmountMinor === 0 && next.balanceDueMinor === 0 ? "full" : "balance";

  const statements: SQLiteBatchItem[] = [
    // The payment row first: its id is the claim (a racing retry inserts nothing).
    db.insert(orderPayments).values({
      id: paymentId,
      orderId: order.id,
      amountMinor: input.amountMinor,
      currency: currency.code,
      // Money received in hand or in the bank is settled as presented.
      ...presentedSettlement(input.amountMinor, currency.code),
      paymentMethod: RECORDED_PAYMENT_METHOD,
      paymentType,
      status: PaymentRecordStatus.SUCCEEDED,
      metadata: JSON.stringify(metadata),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: orderPayments.id }) as unknown as SQLiteBatchItem,
    db.update(orders).set({
      paymentStatus: next.paymentStatus,
      paidAmountMinor: next.paidAmountMinor,
      balanceDueMinor: next.balanceDueMinor,
      version: nextVersion,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(orders.id, order.id),
      eq(orders.version, order.version),
      eq(orders.paidAmountMinor, order.paidAmountMinor),
      eq(orders.balanceDueMinor, order.balanceDueMinor),
      sql`${orders.deletedAt} IS NULL`,
      sql`EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.id} = ${paymentId} AND ${orderPayments.amountMinor} = ${input.amountMinor})`,
    )) as unknown as SQLiteBatchItem,
    buildBatchGuard(db, sql`EXISTS (
      SELECT 1 FROM ${orders}
      WHERE ${orders.id} = ${order.id}
        AND ${orders.version} = ${nextVersion}
        AND ${orders.paidAmountMinor} = ${next.paidAmountMinor}
        AND ${orders.balanceDueMinor} = ${next.balanceDueMinor}
    )`, RECORDED_PAYMENT_BATCH_GUARD) as SQLiteBatchItem,
  ];

  try {
    await safeBatch(db, statements as never);
  } catch (error) {
    if (isBatchGuardError(error, RECORDED_PAYMENT_BATCH_GUARD)) {
      // A retry that lost the race to itself replays; anything else changed the order.
      const replay = await db.select({ amountMinor: orderPayments.amountMinor })
        .from(orderPayments).where(eq(orderPayments.id, paymentId)).get();
      if (replay) return recordOrderPayment(db, input);
      throw new ConflictError("The order's payment changed while this payment was being recorded. Reload and try again.");
    }
    throw error;
  }

  return {
    paymentId,
    paymentStatus: next.paymentStatus,
    paidAmountMinor: next.paidAmountMinor,
    balanceDueMinor: next.balanceDueMinor,
    replayed: false,
  };
}
