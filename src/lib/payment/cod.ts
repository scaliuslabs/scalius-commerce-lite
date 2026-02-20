// src/lib/payment/cod.ts
// Cash on Delivery (COD) tracking and management.
// No external gateway — tracks delivery attempts and cash collection in DB.

import { eq, sql } from "drizzle-orm";
import { codTracking, orders, orderPayments } from "@/db/schema";
import { PaymentStatus } from "@/db/schema";
import type { Database } from "@/db";
import type {
  InitCODTrackingParams,
  RecordCODCollectionParams,
  RecordCODFailureParams,
} from "./types";

/**
 * Create a COD tracking record when a COD order is placed.
 * Called during order creation.
 */
export async function initCODTracking(
  db: Database,
  params: InitCODTrackingParams
): Promise<void> {
  const now = new Date();
  await db.insert(codTracking).values({
    id: crypto.randomUUID(),
    orderId: params.orderId,
    deliveryAttempts: 0,
    codStatus: "pending",
    createdAt: now,
    updatedAt: now,
  });
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
      .select({ id: orders.id, totalAmount: orders.totalAmount })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!order) {
      return { success: false, error: `Order ${params.orderId} not found` };
    }

    const now = new Date();

    // Update COD tracking record
    await db
      .update(codTracking)
      .set({
        codStatus: "collected",
        collectedBy: params.collectedBy,
        collectedAmount: params.collectedAmount,
        collectedAt: now,
        receiptUrl: params.receiptUrl ?? null,
        deliveryAttempts: sql`${codTracking.deliveryAttempts} + 1`,
        lastAttemptAt: now,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, params.orderId));

    // Record the payment transaction
    await db.insert(orderPayments).values({
      id: crypto.randomUUID(),
      orderId: params.orderId,
      amount: params.collectedAmount,
      currency: "BDT",
      paymentMethod: "cod",
      paymentType: "full",
      status: "succeeded",
      codCollectedBy: params.collectedBy,
      codCollectedAt: now,
      codReceiptUrl: params.receiptUrl ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // Update the order payment status and paid amount
    await db
      .update(orders)
      .set({
        paymentStatus: PaymentStatus.PAID,
        paidAmount: params.collectedAmount,
        balanceDue: 0,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, params.orderId));

    return { success: true };
  } catch (err) {
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
    const now = new Date();
    await db
      .update(codTracking)
      .set({
        codStatus: "failed",
        failureReason: params.reason,
        deliveryAttempts: sql`${codTracking.deliveryAttempts} + 1`,
        lastAttemptAt: now,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, params.orderId));

    return { success: true };
  } catch (err) {
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
    await db
      .update(codTracking)
      .set({
        codStatus: "returned",
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, orderId));

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to mark COD as returned";
    return { success: false, error: message };
  }
}
