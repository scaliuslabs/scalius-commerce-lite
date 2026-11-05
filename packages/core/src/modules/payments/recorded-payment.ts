// A payment staff or an app records against a deferred (net terms) order: a
// bank transfer, a cheque or cash received for an invoice. No provider is
// called. The payment row (`payment_method` "manual", RECORDED_PAYMENT_METHOD)
// and the order's new paid amount commit in one guarded batch; its insert
// emits `payment.updated` and a fully paid order emits `order.paid` (event
// outbox triggers). A refund of it is a confirmed manual settlement.
//
// Idempotent: the caller's request key names the payment row, so a retry
// returns the first result and a different payment under the same key is
// refused. The caller's timeline line (`timelineLine`) commits in the same
// batch, so a payment has its line exactly once, whatever is retried or lost.
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  orders,
  orderPayments,
  paymentPlans,
  OrderStatus,
  PaymentRecordStatus,
  PaymentPlanStatus,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "@scalius/shared/hash";
import { presentedSettlement } from "@scalius/shared/money-chain";
import { RECORDED_PAYMENT_METHOD, RECORDED_PAYMENT_VIAS, type RecordedPaymentVia } from "@scalius/shared/payment-terms";
import { computePaymentStateAfterPayment } from "./payment-state";
import { resolveOrderCurrencySnapshot } from "./order-currency";

type SQLiteBatchItem = BatchItem<"sqlite">;

const RECORDED_PAYMENT_BATCH_GUARD = "recorded_payment_state_changed";

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
  /**
   * `"deposit"` when recording a manual COD deposit against a pending manual
   * payment plan. When absent, the type is inferred as `"full"` or `"balance"`
   * as before.
   */
  paymentType?: "deposit";
  /**
   * The order timeline's line for this payment, written in the payment's own
   * batch (the orders module builds it: `buildOrderEventInsert`, keyed by the
   * payment id). `landed` holds once the payment and the order's new paid
   * amount are written. Not called on a replay: the first write committed it.
   * The statement comes back wrapped: a query builder is a thenable, so a
   * promise resolved with it bare would run it on its own.
   */
  timelineLine?: (payment: RecordedPaymentLine) => Promise<{ statement: unknown }>;
  /**
   * A review hold written in the same batch (an app recorded the payment:
   * the orders module's `buildAppPaymentReviewHoldInsert`), so no automatic
   * hand-over can run between the payment landing and the hold.
   */
  reviewHold?: (payment: RecordedPaymentLine) => Promise<{ statement: unknown }>;
}

export interface RecordedPaymentLine {
  paymentId: string;
  currency: { code: string; decimalPlaces: number };
  landed: SQL;
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

/** Generate payment ID for idempotency. Uses only orderId + requestKey for consistent replay.
 * The planId is NOT included to ensure the same requestKey always maps to the same paymentId. */
async function recordedPaymentId(orderId: string, requestKey: string): Promise<string> {
  const hashInput = `recorded\n${orderId}\n${requestKey}`;
  return `recorded:${orderId}:${await sha256Hex(hashInput)}`;
}

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

  // Generate paymentId first (without planId) for consistent idempotency key
  const paymentId = await recordedPaymentId(input.orderId, requestKey);

  // Check for existing payment with this idempotency key BEFORE reading plan
  // This ensures replay works even if plan status changes between calls
  const existing = await db.select({
    amountMinor: orderPayments.amountMinor,
    status: orderPayments.status,
    metadata: orderPayments.metadata,
  }).from(orderPayments).where(eq(orderPayments.id, paymentId)).get();
  if (existing) {
    // Replay: fetch current order state and return full result
    const currentOrder = await db.select({
      paidAmountMinor: orders.paidAmountMinor,
      balanceDueMinor: orders.balanceDueMinor,
    }).from(orders).where(eq(orders.id, input.orderId)).get();
    return {
      paymentId,
      paymentStatus: existing.status,
      paidAmountMinor: currentOrder?.paidAmountMinor ?? 0,
      balanceDueMinor: currentOrder?.balanceDueMinor ?? 0,
      replayed: true,
    };
  }

  // Read order and payment plan for validation (only for new payments)
  const [order, plan] = await Promise.all([
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
      id: paymentPlans.id,
      status: paymentPlans.status,
      kind: paymentPlans.kind,
      depositAmountMinor: paymentPlans.depositAmountMinor,
      balanceDueMinor: paymentPlans.balanceDueMinor,
    }).from(paymentPlans).where(eq(paymentPlans.orderId, input.orderId)).get(),
  ]);
  if (!order || order.deletedAt) throw new NotFoundError("Order not found");

  // Determine if this is a manual COD deposit
  let isDeposit = false;
  const depositRequested = input.paymentType === "deposit";
  if (depositRequested
      && plan
      && plan.kind === "manual"
      && plan.status === PaymentPlanStatus.PENDING) {
    isDeposit = true;
    if (input.amountMinor !== plan.depositAmountMinor) {
      throw new ValidationError("The deposit amount must equal the required deposit exactly.", {
        depositAmountMinor: plan.depositAmountMinor,
      });
    }
    const expectedBalance = Math.max(0, order.totalAmountMinor - input.amountMinor);
    if (plan.balanceDueMinor !== expectedBalance) {
      throw new ValidationError("The deposit plan's balance does not match the order total.");
    }
  } else if (depositRequested) {
    // Explicit deposit request without a matching pending manual plan.
    throw new ValidationError("No pending manual deposit plan found for this order.");
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
  const paymentType = isDeposit
    ? "deposit"
    : (order.paidAmountMinor === 0 && next.balanceDueMinor === 0 ? "full" : "balance");
  // Holds only if this batch claimed the order: its own payment row exists
  // and the order moved to exactly this payment's state.
  const landed = sql`EXISTS (
      SELECT 1 FROM ${orders}
      WHERE ${orders.id} = ${order.id}
        AND EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.id} = ${paymentId})
        AND ${orders.version} = ${nextVersion}
        AND ${orders.paidAmountMinor} = ${next.paidAmountMinor}
        AND ${orders.balanceDueMinor} = ${next.balanceDueMinor}
    )`;
  const timelineLine = input.timelineLine
    ? (await input.timelineLine({ paymentId, currency, landed })).statement
    : undefined;
  const reviewHold = input.reviewHold
    ? (await input.reviewHold({ paymentId, currency, landed })).statement
    : undefined;

  const settlement = presentedSettlement(input.amountMinor, currency.code);
  const orderUnchanged = and(
    eq(orders.id, order.id),
    eq(orders.version, order.version),
    eq(orders.paidAmountMinor, order.paidAmountMinor),
    eq(orders.balanceDueMinor, order.balanceDueMinor),
    sql`${orders.deletedAt} IS NULL`,
  );
  const statements: SQLiteBatchItem[] = [
    ...(isDeposit && plan ? [buildBatchGuard(db, sql`EXISTS (
      SELECT 1 FROM ${paymentPlans}
      WHERE ${paymentPlans.id} = ${plan.id}
        AND ${paymentPlans.orderId} = ${order.id}
        AND ${paymentPlans.kind} = 'manual'
        AND ${paymentPlans.status} = ${PaymentPlanStatus.PENDING}
        AND ${paymentPlans.depositAmountMinor} = ${plan.depositAmountMinor}
        AND ${paymentPlans.balanceDueMinor} = ${plan.balanceDueMinor}
    )`, RECORDED_PAYMENT_BATCH_GUARD) as SQLiteBatchItem] : []),
    // The payment row first, and only while the order is still the one read:
    // its id is the claim (a racing retry inserts nothing), and a payment
    // racing under another key finds the order moved and inserts nothing, so
    // no row is ever left that the order's paid amount does not count.
    db.insert(orderPayments).select(db.select({
      id: sql<string>`${paymentId}`.as("id"),
      orderId: orders.id,
      amountMinor: sql<number>`${input.amountMinor}`.as("amount_minor"),
      currency: sql<string>`${currency.code}`.as("currency"),
      // Money received in hand or in the bank is settled as presented.
      settlementCurrency: sql<string>`${settlement.settlementCurrency}`.as("settlement_currency"),
      settlementAmountMinor: sql<number>`${settlement.settlementAmountMinor}`.as("settlement_amount_minor"),
      settlementRate: sql<string>`${settlement.settlementRate}`.as("settlement_rate"),
      exchangeAdjustmentMinor: sql<number>`${settlement.exchangeAdjustmentMinor}`.as("exchange_adjustment_minor"),
      paymentMethod: sql<string>`${RECORDED_PAYMENT_METHOD}`.as("payment_method"),
      paymentType: sql<string>`${paymentType}`.as("payment_type"),
      status: sql<string>`${PaymentRecordStatus.SUCCEEDED}`.as("status"),
      providerRef: sql<null>`NULL`.as("provider_ref"),
      providerSecondaryRef: sql<null>`NULL`.as("provider_secondary_ref"),
      codCollectedBy: sql<null>`NULL`.as("cod_collected_by"),
      codCollectedAt: sql<null>`NULL`.as("cod_collected_at"),
      codReceiptUrl: sql<null>`NULL`.as("cod_receipt_url"),
      metadata: sql<string>`${JSON.stringify(metadata)}`.as("metadata"),
      createdAt: sql<Date>`unixepoch()`.as("created_at"),
      updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
      settlementProvenance: sql<typeof settlement.settlementProvenance>`${settlement.settlementProvenance}`.as("settlement_provenance"),
    }).from(orders).where(orderUnchanged)).onConflictDoNothing({ target: orderPayments.id }) as unknown as SQLiteBatchItem,
    db.update(orders).set({
      paymentStatus: next.paymentStatus,
      paidAmountMinor: next.paidAmountMinor,
      balanceDueMinor: next.balanceDueMinor,
      version: nextVersion,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      orderUnchanged,
      sql`EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.id} = ${paymentId} AND ${orderPayments.amountMinor} = ${input.amountMinor})`,
    )) as unknown as SQLiteBatchItem,
    ...(isDeposit && plan ? [
      db.update(paymentPlans).set({
        status: PaymentPlanStatus.DEPOSIT_PAID,
        depositPaidAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }).where(and(
        eq(paymentPlans.id, plan.id),
        eq(paymentPlans.orderId, order.id),
        eq(paymentPlans.status, PaymentPlanStatus.PENDING),
      )) as unknown as SQLiteBatchItem,
    ] : []),
    ...(timelineLine ? [timelineLine as SQLiteBatchItem] : []),
    ...(reviewHold ? [reviewHold as SQLiteBatchItem] : []),
    buildBatchGuard(db, landed, RECORDED_PAYMENT_BATCH_GUARD) as SQLiteBatchItem,
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
