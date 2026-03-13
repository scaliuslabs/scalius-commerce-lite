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
  OrderStatus,
  InventoryPool,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { releaseMultiple } from "../inventory/release";
import type { ProcessPaymentParams, PaymentGateway } from "./types";
import { getCurrencyConfig } from "../settings/settings.service";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";

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
        status: orders.status,
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
    if (params.polarCheckoutId) {
      const existing = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(eq(orderPayments.polarCheckoutId, params.polarCheckoutId))
        .get();
      if (existing) return { success: true };
    }

    const now = new Date();
    const newPaidAmount = (order.paidAmount ?? 0) + params.amount;
    const newBalanceDue = Math.max(0, order.totalAmount - newPaidAmount);
    const isFullyPaid = newBalanceDue <= 0.01; // Allow tiny float drift

    console.log(`[process-payment] Order ${params.orderId}: amount=${params.amount}, totalAmount=${order.totalAmount}, paidAmount=${order.paidAmount}, newPaidAmount=${newPaidAmount}, newBalanceDue=${newBalanceDue}, isFullyPaid=${isFullyPaid}`);

    // Determine new payment status
    const newPaymentStatus = isFullyPaid
      ? PaymentStatus.PAID
      : PaymentStatus.PARTIAL;

    // Fetch currency config
    const currencyConfig = await getCurrencyConfig(db);

    // 1. Record this payment transaction
    await db.insert(orderPayments).values({
      id: crypto.randomUUID(),
      orderId: params.orderId,
      amount: params.amount,
      currency: currencyConfig.code,
      paymentMethod: params.paymentGateway,
      paymentType: params.paymentType,
      status: "succeeded",
      stripePaymentIntentId: params.stripePaymentIntentId ?? null,
      stripeChargeId: params.stripeChargeId ?? null,
      sslcommerzTranId: params.sslcommerzTranId ?? null,
      sslcommerzValId: params.sslcommerzValId ?? null,
      sslcommerzBankTranId: params.sslcommerzBankTranId ?? null,
      polarCheckoutId: params.polarCheckoutId ?? null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Update order totals and payment status
    const newStatus = order.status === OrderStatus.INCOMPLETE ? OrderStatus.PENDING : order.status;
    const orderUpdates: any = {
      status: newStatus,
      paidAmount: newPaidAmount,
      balanceDue: newBalanceDue,
      paymentStatus: newPaymentStatus,
      updatedAt: sql`unixepoch()`,
    };

    await db
      .update(orders)
      .set(orderUpdates)
      .where(eq(orders.id, params.orderId));

    // 3. Apply central inventory transitions (e.g. reserving -> deducted because status is now active)
    await applyInventoryForStatusChange(db, params.orderId, newStatus).catch((err) =>
      console.error(`[process-payment] Failed to apply inventory transition for ${params.orderId}:`, err)
    );

    // 4. Update payment plan if this is a deposit or balance payment
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
    const currencyConfig = await getCurrencyConfig(db);
    await db.insert(orderPayments).values({
      id: crypto.randomUUID(),
      orderId,
      amount: 0,
      currency: currencyConfig.code,
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

    // Mark inventory as restored
    await db
      .update(orders)
      .set({ inventoryAction: "restored" })
      .where(eq(orders.id, orderId));
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
