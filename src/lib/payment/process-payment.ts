// src/lib/payment/process-payment.ts
// Shared business logic for processing confirmed payments.
// Called by both Stripe and SSLCommerz webhook handlers after signature verification.

import { eq, sql } from "drizzle-orm";
import {
  orders,
  orderItems,
  orderPayments,
  paymentPlans,
  webhookEvents,
  PaymentStatus,
  InventoryPool,
} from "@/db/schema";
import type { Database } from "@/db";
import { deductMultiple } from "@/lib/inventory/deduct";
import { releaseMultiple } from "@/lib/inventory/release";
import { checkAndAlertLowStock } from "@/lib/inventory/alerts";
import type { ProcessPaymentParams, PaymentGateway } from "./types";

/**
 * Process a confirmed payment event.
 *
 * This function:
 * 1. Records the payment in orderPayments
 * 2. Updates order.paidAmount, order.paymentStatus, order.balanceDue
 * 3. Updates paymentPlans if applicable
 * 4. Permanently deducts inventory (converts reservation → deduction)
 * 5. Triggers low-stock alert checks
 *
 * Idempotent: checking for existing orderPayments prevents double-processing.
 */
export async function processPaymentConfirmed(
  db: Database,
  params: ProcessPaymentParams
): Promise<{ success: boolean; error?: string }> {
  try {
    // Fetch the order
    const order = await db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        paymentStatus: orders.paymentStatus,
        inventoryPool: orders.inventoryPool,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!order) {
      return { success: false, error: `Order ${params.orderId} not found` };
    }

    // Guard: already fully paid
    if (order.paymentStatus === PaymentStatus.PAID) {
      return { success: true }; // Idempotent — already processed
    }

    // Check for duplicate payment record (Stripe retry protection)
    if (params.stripePaymentIntentId) {
      const existing = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(eq(orderPayments.stripePaymentIntentId, params.stripePaymentIntentId))
        .get();
      if (existing) return { success: true }; // Already processed
    }
    if (params.sslcommerzTranId) {
      const existing = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(eq(orderPayments.sslcommerzTranId, params.sslcommerzTranId))
        .get();
      if (existing) return { success: true };
    }

    const now = new Date();
    const newPaidAmount = (order.paidAmount ?? 0) + params.amount;
    const newBalanceDue = Math.max(0, order.totalAmount - newPaidAmount);
    const isFullyPaid = newBalanceDue <= 0.01; // Allow tiny float drift

    // Determine new payment status
    const newPaymentStatus = isFullyPaid
      ? PaymentStatus.PAID
      : PaymentStatus.PARTIAL;

    // 1. Record this payment transaction
    await db.insert(orderPayments).values({
      id: crypto.randomUUID(),
      orderId: params.orderId,
      amount: params.amount,
      currency: "BDT",
      paymentMethod: params.paymentGateway,
      paymentType: params.paymentType,
      status: "succeeded",
      stripePaymentIntentId: params.stripePaymentIntentId ?? null,
      stripeChargeId: params.stripeChargeId ?? null,
      sslcommerzTranId: params.sslcommerzTranId ?? null,
      sslcommerzValId: params.sslcommerzValId ?? null,
      sslcommerzBankTranId: params.sslcommerzBankTranId ?? null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Update order totals and payment status
    await db
      .update(orders)
      .set({
        paidAmount: newPaidAmount,
        balanceDue: newBalanceDue,
        paymentStatus: newPaymentStatus,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, params.orderId));

    // 3. Update payment plan if this is a deposit or balance payment
    if (params.paymentType === "deposit") {
      await db
        .update(paymentPlans)
        .set({
          status: "deposit_paid",
          depositPaidAt: now,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(paymentPlans.orderId, params.orderId));
    } else if (params.paymentType === "balance" && isFullyPaid) {
      await db
        .update(paymentPlans)
        .set({
          status: "fully_paid",
          balancePaidAt: now,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(paymentPlans.orderId, params.orderId));
    }

    // 4. On full payment: permanently deduct inventory
    if (isFullyPaid) {
      const items = await db
        .select({
          variantId: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, params.orderId))
        .all();

      const pool = (order.inventoryPool ?? InventoryPool.REGULAR) as
        | "regular"
        | "preorder"
        | "backorder";

      const entries = items
        .filter((i) => i.variantId !== null)
        .map((i) => ({
          variantId: i.variantId as string,
          quantity: i.quantity,
          pool,
        }));

      if (entries.length > 0) {
        const deductResult = await deductMultiple(db, entries, params.orderId);
        if (!deductResult.success) {
          // Log but don't fail the payment — stock can be reconciled later
          console.error(
            `[process-payment] Inventory deduction failed for order ${params.orderId}:`,
            deductResult.error
          );
        }

        // 5. Check low-stock alerts for each variant
        for (const entry of entries) {
          await checkAndAlertLowStock(db, entry.variantId);
        }
      }
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Payment processing error";
    console.error(`[process-payment] Error for order ${params.orderId}:`, err);
    return { success: false, error: message };
  }
}

/**
 * Process a failed payment event.
 * Updates order.paymentStatus to FAILED if no prior payments exist.
 */
export async function processPaymentFailed(
  db: Database,
  orderId: string,
  gateway: PaymentGateway,
  intentId?: string
): Promise<void> {
  try {
    const order = await db
      .select({ paidAmount: orders.paidAmount, paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();

    if (!order) return;

    // Only mark as failed if no prior payment was collected
    if (!order.paidAmount || order.paidAmount <= 0) {
      await db
        .update(orders)
        .set({
          paymentStatus: PaymentStatus.FAILED,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, orderId));
    }

    // Record the failed attempt
    await db.insert(orderPayments).values({
      id: crypto.randomUUID(),
      orderId,
      amount: 0,
      currency: "BDT",
      paymentMethod: gateway,
      paymentType: "full",
      status: "failed",
      stripePaymentIntentId: gateway === "stripe" ? (intentId ?? null) : null,
      sslcommerzTranId: gateway === "sslcommerz" ? (intentId ?? null) : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (err) {
    console.error(`[process-payment] Failed payment recording error:`, err);
  }
}

/**
 * Release inventory reservations when an order is fully cancelled.
 * Called when: order cancelled before payment, payment refunded and order voided.
 */
export async function releaseOrderInventory(
  db: Database,
  orderId: string
): Promise<void> {
  try {
    const order = await db
      .select({ inventoryPool: orders.inventoryPool })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();

    if (!order) return;

    const items = await db
      .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .all();

    const pool = (order.inventoryPool ?? InventoryPool.REGULAR) as
      | "regular"
      | "preorder"
      | "backorder";

    const entries = items
      .filter((i) => i.variantId !== null)
      .map((i) => ({
        variantId: i.variantId as string,
        quantity: i.quantity,
        pool,
      }));

    if (entries.length > 0) {
      await releaseMultiple(db, entries, orderId);
    }
  } catch (err) {
    console.error(`[process-payment] Inventory release error for order ${orderId}:`, err);
  }
}

/**
 * Record a webhook event for idempotency tracking.
 */
export async function recordWebhookEvent(
  db: Database,
  id: string,
  provider: string,
  eventType: string,
  orderId: string | null,
  status: "processed" | "failed",
  result?: unknown
): Promise<void> {
  try {
    await db.insert(webhookEvents).values({
      id,
      provider,
      eventType,
      orderId: orderId ?? null,
      status,
      result: result ? JSON.stringify(result) : null,
      processedAt: new Date(),
    });
  } catch {
    // Duplicate key = already recorded — safe to ignore
  }
}
