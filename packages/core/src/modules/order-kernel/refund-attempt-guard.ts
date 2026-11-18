import type { Database } from "@scalius/database/client";
import { orders, orderPayments, PaymentRecordStatus, refundAttempts } from "@scalius/database/schema";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { ConflictError } from "@scalius/core/errors";
import { qualifiedColumn } from "../../utils/qualified-column";
import { refundTakenByProviderSql } from "../payments/refund-attempt-machine";

export const ACTIVE_REFUND_ATTEMPT_STATUSES = [
  "pending",
  "processing",
  "provider_unknown",
  "reconcile_required",
] as const;

/**
 * How long a refund in flight may stay in a state before it needs a person.
 * `reconcile_required`: the provider accepted it and only the order's own
 * update is left, which the next reconciliation run normally finishes (every
 * 15 minutes); still there after one run, it failed and staff look.
 * `provider_unknown`: the provider has not answered; a provider still working
 * answers within a day, so past that (or when its gateway cannot be checked,
 * which reconciliation retries only every six hours) staff look. One the
 * provider took and is completing (`refundTakenByProvider`) never needs a
 * person for its age: a refund waiting on the merchant's balance or the
 * buyer's bank details takes days.
 * `pending` and `processing` are released or moved on by reconciliation
 * itself and never wait on staff.
 */
export const REFUND_NEEDS_STAFF_AFTER_SECONDS = {
  reconcile_required: 15 * 60,
  provider_unknown: 24 * 60 * 60,
} as const;

/**
 * The orders with a refund in flight that waits on staff (Home's "Refunds
 * that need you", the orders view `refunds_to_resolve`): one range of a
 * status-led refund-attempt index per state, so the read grows with the
 * stuck refunds, never with the refund history.
 */
export function refundsNeedingStaffOrderIds(): SQL {
  return sql.join(Object.entries(REFUND_NEEDS_STAFF_AFTER_SECONDS).map(([status, seconds]) =>
    sql`SELECT ${refundAttempts.orderId} AS order_id FROM ${refundAttempts}
      WHERE ${refundAttempts.status} = ${status} AND ${refundAttempts.createdAt} <= unixepoch() - ${seconds}
        AND NOT ${refundTakenByProviderSql()}`), sql` UNION `);
}

/**
 * The one precondition of every write to a refund attempt and to its refund
 * payment row: the attempt still has the status the writer read and still
 * carries the writer's claim. A writer whose lease ran out (reconciliation
 * released the attempt, or took it over) matches nothing and must stop: it
 * never revives an attempt, so the money is never sent a second time.
 */
export function refundAttemptHeldCondition(attemptId: string, claimId: string, statuses: readonly string[]): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${refundAttempts}
    WHERE ${refundAttempts.id} = ${attemptId}
      AND ${refundAttempts.claimId} = ${claimId}
      AND ${refundAttempts.status} IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
  )`;
}

/** The batch-guard marker of a refund-attempt write whose claim was lost. */
export const REFUND_ATTEMPT_CLAIM_LOST = "refund_attempt_claim_lost";

/** A refund attempt writer lost its claim: nothing it would have written was written. */
export class RefundAttemptClaimLostError extends ConflictError {
  constructor() {
    super("This refund is being finished by reconciliation. Reload the order before trying again.");
    this.name = "RefundAttemptClaimLostError";
  }
}

export const REFUND_IN_PROGRESS_MESSAGE =
  "A refund is already in progress for this order. Please wait and retry.";

export const ORDER_REFUND_MUTATION_BLOCKED_MESSAGE =
  "Order has an active refund operation. Complete or reconcile the refund before changing this order.";

export interface ActiveRefundAttemptSnapshot {
  id: string;
  orderId: string;
  status: string;
  amountMinor: number;
  providerRefundId: string | null;
}

export interface ActiveRefundGuardOptions {
  allowAttemptId?: string;
  message?: string;
}

const activeStatusList = sql.join(
  ACTIVE_REFUND_ATTEMPT_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

export function noActiveRefundAttemptForOrderIdCondition(orderId: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${refundAttempts}
    WHERE ${refundAttempts.orderId} = ${orderId}
      AND ${refundAttempts.status} IN (${activeStatusList})
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${orderPayments}
    WHERE ${orderPayments.orderId} = ${orderId}
      AND ${orderPayments.paymentType} = 'refund'
      AND ${orderPayments.status} = ${PaymentRecordStatus.PENDING}
  )`;
}

/**
 * No active refund for the order row the caller names (default: the `orders`
 * row of the statement), always qualified: a bare column would bind to the
 * subquery's own `order_id`/`id` when this lands in a single-table select list.
 */
export function noActiveRefundAttemptForOrderColumnCondition(orderIdColumn: SQL = qualifiedColumn(orders.id)): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${refundAttempts}
    WHERE ${refundAttempts.orderId} = ${orderIdColumn}
      AND ${refundAttempts.status} IN (${activeStatusList})
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${orderPayments}
    WHERE ${orderPayments.orderId} = ${orderIdColumn}
      AND ${orderPayments.paymentType} = 'refund'
      AND ${orderPayments.status} = ${PaymentRecordStatus.PENDING}
  )`;
}

export async function findActiveRefundAttempt(
  db: Database,
  orderId: string,
  options: Pick<ActiveRefundGuardOptions, "allowAttemptId"> = {},
): Promise<ActiveRefundAttemptSnapshot | null> {
  const conditions = [
    eq(refundAttempts.orderId, orderId),
    inArray(refundAttempts.status, [...ACTIVE_REFUND_ATTEMPT_STATUSES]),
  ];

  if (options.allowAttemptId) {
    conditions.push(ne(refundAttempts.id, options.allowAttemptId));
  }

  const attempt = await db
    .select({
      id: refundAttempts.id,
      orderId: refundAttempts.orderId,
      status: refundAttempts.status,
      amountMinor: refundAttempts.amountMinor,
      providerRefundId: refundAttempts.providerRefundId,
    })
    .from(refundAttempts)
    .where(and(...conditions))
    .get();

  return attempt ?? null;
}

async function hasLegacyPendingRefund(db: Database, orderId: string): Promise<boolean> {
  const pendingRefund = await db
    .select({ id: orderPayments.id })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.orderId, orderId),
      eq(orderPayments.paymentType, "refund"),
      eq(orderPayments.status, PaymentRecordStatus.PENDING),
    ))
    .get();

  return Boolean(pendingRefund);
}

export async function assertNoActiveRefundAttempt(
  db: Database,
  orderId: string,
  options: ActiveRefundGuardOptions = {},
): Promise<void> {
  const attempt = await findActiveRefundAttempt(db, orderId, options);
  if (attempt || await hasLegacyPendingRefund(db, orderId)) {
    throw new ConflictError(options.message ?? ORDER_REFUND_MUTATION_BLOCKED_MESSAGE);
  }
}

// ── The order's own changes ─────────────────────────────────────────────────
//
// Two questions about a refund in flight. "May another refund, or a dispute's
// settling, start?" (above: any refund in flight, `noActiveRefundAttempt…`):
// the money may still be going back. "May this order's status, fulfilment,
// courier booking or archive move?" (below): not while a refund's outcome is
// open or its money is being recorded, but yes while the provider took it
// and is completing it (`refundTakenByProvider`): that refund is on its way
// whatever the order does next, and it can take days.

/** An in-flight attempt of the order that its provider has not taken (the WHERE of a read of `refund_attempts`). */
function lockingRefundAttemptWhere(orderIdSql: SQL | string): SQL {
  return sql`${refundAttempts.orderId} = ${orderIdSql}
      AND ${refundAttempts.status} IN (${activeStatusList})
      AND NOT ${refundTakenByProviderSql()}`;
}

/** A pending refund row of the order that no attempt its provider took stands for (the WHERE of a read of `order_payments`). */
function lockingPendingRefundWhere(orderIdSql: SQL | string): SQL {
  const taken = refundTakenByProviderSql({
    status: sql.raw("taken.status"), providerRefundId: sql.raw("taken.provider_refund_id"), lastError: sql.raw("taken.last_error"),
  });
  return sql`${orderPayments.orderId} = ${orderIdSql}
      AND ${orderPayments.paymentType} = 'refund'
      AND ${orderPayments.status} = ${PaymentRecordStatus.PENDING}
      AND NOT EXISTS (SELECT 1 FROM ${refundAttempts} AS taken WHERE taken.refund_payment_id = ${orderPayments.id} AND ${taken})`;
}

/** A refund locks the order (`orderIdSql`): an attempt in flight its provider has not taken, or a pending refund row of none. */
function refundLocksOrderSql(orderIdSql: SQL | string): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${refundAttempts} WHERE ${lockingRefundAttemptWhere(orderIdSql)})
    OR EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${lockingPendingRefundWhere(orderIdSql)}))`;
}

/** No refund locks the order's changes (for a batch guard or a WHERE). */
export function noRefundLocksOrderForIdCondition(orderId: string): SQL {
  return sql`NOT ${refundLocksOrderSql(orderId)}`;
}

/** The same over the order row a statement names (default: the `orders` row), always qualified. */
export function noRefundLocksOrderForColumnCondition(orderIdColumn: SQL = qualifiedColumn(orders.id)): SQL {
  return sql`NOT ${refundLocksOrderSql(orderIdColumn)}`;
}

/** Refuses a change to the order while a refund locks it. */
export async function assertNoRefundLocksOrder(
  db: Database,
  orderId: string,
  options: Pick<ActiveRefundGuardOptions, "message"> = {},
): Promise<void> {
  const attempt = await db.select({ id: refundAttempts.id }).from(refundAttempts).where(lockingRefundAttemptWhere(orderId)).get();
  const pendingRefund = attempt
    ? null
    : await db.select({ id: orderPayments.id }).from(orderPayments).where(lockingPendingRefundWhere(orderId)).get();
  if (attempt || pendingRefund) throw new ConflictError(options.message ?? ORDER_REFUND_MUTATION_BLOCKED_MESSAGE);
}

/** Refuses a change to any of the orders while a refund locks one. */
export async function assertNoRefundLocksOrders(
  db: Database,
  orderIds: string[],
  options: Pick<ActiveRefundGuardOptions, "message"> = {},
): Promise<void> {
  const uniqueOrderIds = [...new Set(orderIds)].filter(Boolean);
  if (uniqueOrderIds.length === 0) return;
  const locked = await db.select({ id: orders.id }).from(orders)
    .where(and(inArray(orders.id, uniqueOrderIds), refundLocksOrderSql(qualifiedColumn(orders.id))));
  if (locked.length === 0) return;
  throw new ConflictError(
    options.message ?? `${ORDER_REFUND_MUTATION_BLOCKED_MESSAGE} Affected orders: ${locked.map((row) => row.id).join(", ")}.`,
  );
}
