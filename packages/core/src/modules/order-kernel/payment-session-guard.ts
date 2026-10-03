// src/modules/order-kernel/payment-session-guard.ts
// The hosted-payment lock: while a payment session is being set up for an
// order (a claimed `processing` attempt whose lease has not expired), nothing
// else may change the order.

import type { Database } from "@scalius/database/client";
import { paymentSessionAttempts } from "@scalius/database/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ConflictError } from "@scalius/core/errors";

export const ACTIVE_PAYMENT_SESSION_SETUP_MESSAGE =
  "Order has an active hosted payment setup in progress. Wait for payment setup to finish before changing this order.";

export function activePaymentSessionAttemptExistsCondition(orderIdSql: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${paymentSessionAttempts}
    WHERE ${paymentSessionAttempts.orderId} = ${orderIdSql}
      AND ${paymentSessionAttempts.status} = 'processing'
      AND ${paymentSessionAttempts.claimExpiresAt} IS NOT NULL
      AND ${paymentSessionAttempts.claimExpiresAt} > unixepoch()
  )`;
}

export function noActivePaymentSessionAttemptForOrderSqlCondition(orderIdSql: SQL): SQL {
  return sql`NOT ${activePaymentSessionAttemptExistsCondition(orderIdSql)}`;
}

export function noActivePaymentSessionAttemptForOrderIdCondition(orderId: string): SQL {
  return noActivePaymentSessionAttemptForOrderSqlCondition(sql`${orderId}`);
}

export async function assertNoActivePaymentSessionAttemptsForOrders(
  db: Database,
  orderIds: string[],
  message = ACTIVE_PAYMENT_SESSION_SETUP_MESSAGE,
): Promise<void> {
  const uniqueOrderIds = [...new Set(orderIds)].filter(Boolean);
  if (uniqueOrderIds.length === 0) return;

  const rows = await db
    .select({ orderId: paymentSessionAttempts.orderId })
    .from(paymentSessionAttempts)
    .where(and(
      inArray(paymentSessionAttempts.orderId, uniqueOrderIds),
      eq(paymentSessionAttempts.status, "processing"),
      sql`${paymentSessionAttempts.claimExpiresAt} IS NOT NULL`,
      sql`${paymentSessionAttempts.claimExpiresAt} > unixepoch()`,
    ))
    .all();

  const affectedOrderIds = [...new Set(rows.map((row) => row.orderId).filter(Boolean))];
  if (affectedOrderIds.length > 0) {
    throw new ConflictError(`${message} Affected orders: ${affectedOrderIds.join(", ")}.`);
  }
}

export async function assertNoActivePaymentSessionAttempt(
  db: Database,
  orderId: string,
  message = ACTIVE_PAYMENT_SESSION_SETUP_MESSAGE,
): Promise<void> {
  await assertNoActivePaymentSessionAttemptsForOrders(db, [orderId], message);
}
