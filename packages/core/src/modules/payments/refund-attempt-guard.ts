import type { Database } from "@scalius/database/client";
import { orders, orderPayments, PaymentRecordStatus, refundAttempts } from "@scalius/database/schema";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { ConflictError } from "@scalius/core/errors";

export const ACTIVE_REFUND_ATTEMPT_STATUSES = [
  "pending",
  "processing",
  "provider_unknown",
  "reconcile_required",
] as const;

export type ActiveRefundAttemptStatus = (typeof ACTIVE_REFUND_ATTEMPT_STATUSES)[number];

export const REFUND_IN_PROGRESS_MESSAGE =
  "A refund is already in progress for this order. Please wait and retry.";

export const ORDER_REFUND_MUTATION_BLOCKED_MESSAGE =
  "Order has an active refund operation. Complete or reconcile the refund before changing this order.";

export interface ActiveRefundAttemptSnapshot {
  id: string;
  orderId: string;
  status: string;
  amount: number;
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

export function noActiveRefundAttemptForOrderColumnCondition(orderIdColumn: SQL = sql`${orders.id}`): SQL {
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
      amount: refundAttempts.amount,
      providerRefundId: refundAttempts.providerRefundId,
    })
    .from(refundAttempts)
    .where(and(...conditions))
    .get();

  return attempt ?? null;
}

export async function findActiveRefundAttemptsForOrders(
  db: Database,
  orderIds: string[],
): Promise<ActiveRefundAttemptSnapshot[]> {
  const uniqueOrderIds = [...new Set(orderIds)].filter(Boolean);
  if (uniqueOrderIds.length === 0) return [];

  return db
    .select({
      id: refundAttempts.id,
      orderId: refundAttempts.orderId,
      status: refundAttempts.status,
      amount: refundAttempts.amount,
      providerRefundId: refundAttempts.providerRefundId,
    })
    .from(refundAttempts)
    .where(and(
      inArray(refundAttempts.orderId, uniqueOrderIds),
      inArray(refundAttempts.status, [...ACTIVE_REFUND_ATTEMPT_STATUSES]),
    ));
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

async function findLegacyPendingRefundOrderIds(db: Database, orderIds: string[]): Promise<string[]> {
  const uniqueOrderIds = [...new Set(orderIds)].filter(Boolean);
  if (uniqueOrderIds.length === 0) return [];

  const rows = await db
    .select({ orderId: orderPayments.orderId })
    .from(orderPayments)
    .where(and(
      inArray(orderPayments.orderId, uniqueOrderIds),
      eq(orderPayments.paymentType, "refund"),
      eq(orderPayments.status, PaymentRecordStatus.PENDING),
    ));

  return [...new Set(rows.map((row) => row.orderId))];
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

export async function assertNoActiveRefundAttemptsForOrders(
  db: Database,
  orderIds: string[],
  options: Pick<ActiveRefundGuardOptions, "message"> = {},
): Promise<void> {
  const attempts = await findActiveRefundAttemptsForOrders(db, orderIds);
  const legacyOrderIds = await findLegacyPendingRefundOrderIds(db, orderIds);
  if (attempts.length === 0 && legacyOrderIds.length === 0) return;

  const affectedOrderIds = [...new Set([
    ...attempts.map((attempt) => attempt.orderId),
    ...legacyOrderIds,
  ])];
  throw new ConflictError(
    options.message ?? `${ORDER_REFUND_MUTATION_BLOCKED_MESSAGE} Affected orders: ${affectedOrderIds.join(", ")}.`,
  );
}
