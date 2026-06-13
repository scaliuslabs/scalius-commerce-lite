// src/modules/payments/process-payment.ts
// Shared business logic for processing confirmed payments.
// Called by both Stripe and SSLCommerz webhook handlers after signature verification.

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  orders,
  orderPayments,
  paymentPlans,
  webhookEvents,
  PaymentStatus,
  OrderStatus,
  PaymentRecordStatus,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import type { ProcessPaymentParams, PaymentGateway } from "./types";
import { getCurrencyConfig } from "../settings/settings.service";
import { validateTransition } from "../orders/order-state-machine";
import { roundPrice, pricesEqual } from "@scalius/shared/price-utils";
import { assertNoActiveShipmentClaim, hasActiveShipmentClaim, SHIPMENT_CLAIM_CONFLICT_MESSAGE } from "../orders/shipment-claim";
import {
  getUnpayableOrderReason,
  PAYMENT_BLOCKED_ORDER_STATUSES,
  PAYMENT_BLOCKED_PAYMENT_STATUSES,
} from "./payable-order";

const PAYMENT_CONFIRMATION_MAX_CAS_ATTEMPTS = 3;

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|primary key/i.test(message);
}

function paymentRecordMatchesAmount(recordedAmount: number, incomingAmount: number): boolean {
  return pricesEqual(roundPrice(recordedAmount), roundPrice(incomingAmount));
}

function failedAttemptCanBePromoted(record: { amount: number; status: string }, incomingAmount: number): boolean {
  if (record.status === PaymentRecordStatus.FAILED) return true;
  return paymentRecordMatchesAmount(record.amount, incomingAmount);
}

/**
 * Process a confirmed payment event.
 *
 * This function:
 * 1. Records the payment in orderPayments
 * 2. Updates order.paidAmount, order.paymentStatus, order.balanceDue
 * 3. Updates paymentPlans if applicable
 *
 * Idempotent: checking for existing orderPayments prevents double-processing.
 */
export async function processPaymentConfirmed(
  db: Database,
  params: ProcessPaymentParams
): Promise<{ success: boolean; error?: string; retryable?: boolean }> {
  try {
    const shipmentClaim = await db
      .select({
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();
    if (shipmentClaim && hasActiveShipmentClaim(shipmentClaim)) {
      return { success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE };
    }

    // ── 0. Claim or resume the gateway payment record ──
    // Unique partial indexes on the gateway IDs are the primary idempotency
    // guarantee. We store a pending local claim first, then mark it succeeded
    // only after the order amount update wins its optimistic-lock check.
    let paymentId: string | undefined;
    if (params.stripePaymentIntentId) {
      const existing = await db
        .select({ id: orderPayments.id, amount: orderPayments.amount, status: orderPayments.status })
        .from(orderPayments)
        .where(and(
          eq(orderPayments.orderId, params.orderId),
          eq(orderPayments.stripePaymentIntentId, params.stripePaymentIntentId),
        ))
        .get();
      if (existing) {
        if (!failedAttemptCanBePromoted(existing, params.amount)) {
          return { success: false, error: "Existing Stripe payment amount does not match webhook amount" };
        }
        if (existing.status === PaymentRecordStatus.SUCCEEDED) return { success: true };
        paymentId = existing.id;
      }
    }
    if (!paymentId && params.sslcommerzTranId) {
      const existing = await db
        .select({ id: orderPayments.id, amount: orderPayments.amount, status: orderPayments.status })
        .from(orderPayments)
        .where(and(
          eq(orderPayments.orderId, params.orderId),
          eq(orderPayments.sslcommerzTranId, params.sslcommerzTranId),
        ))
        .get();
      if (existing) {
        if (!failedAttemptCanBePromoted(existing, params.amount)) {
          return { success: false, error: "Existing SSLCommerz payment amount does not match webhook amount" };
        }
        if (existing.status === PaymentRecordStatus.SUCCEEDED) return { success: true };
        paymentId = existing.id;
      }
    }
    if (!paymentId && params.polarCheckoutId) {
      const existing = await db
        .select({ id: orderPayments.id, amount: orderPayments.amount, status: orderPayments.status })
        .from(orderPayments)
        .where(and(
          eq(orderPayments.orderId, params.orderId),
          eq(orderPayments.polarCheckoutId, params.polarCheckoutId),
        ))
        .get();
      if (existing) {
        if (!failedAttemptCanBePromoted(existing, params.amount)) {
          return { success: false, error: "Existing Polar payment amount does not match webhook amount" };
        }
        if (existing.status === PaymentRecordStatus.SUCCEEDED) return { success: true };
        paymentId = existing.id;
      }
    }

    const initialOrder = await db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        paymentStatus: orders.paymentStatus,
        status: orders.status,
        inventoryPool: orders.inventoryPool,
        version: orders.version,
        deletedAt: orders.deletedAt,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!initialOrder) {
      return { success: false, error: `Order ${params.orderId} not found` };
    }

    const initialUnpayableReason = getUnpayableOrderReason(initialOrder);
    if (initialUnpayableReason) {
      return { success: false, error: initialUnpayableReason, retryable: false };
    }

    const currencyConfig = await getCurrencyConfig(db);
    if (!paymentId) {
      paymentId = crypto.randomUUID();
      try {
        await db.insert(orderPayments).values({
          id: paymentId,
          orderId: params.orderId,
          amount: params.amount,
          currency: currencyConfig.code,
          paymentMethod: params.paymentGateway,
          paymentType: params.paymentType,
          status: PaymentRecordStatus.PENDING,
          stripePaymentIntentId: params.stripePaymentIntentId ?? null,
          stripeChargeId: params.stripeChargeId ?? null,
          sslcommerzTranId: params.sslcommerzTranId ?? null,
          sslcommerzValId: params.sslcommerzValId ?? null,
          sslcommerzBankTranId: params.sslcommerzBankTranId ?? null,
          polarCheckoutId: params.polarCheckoutId ?? null,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        });
      } catch (error: unknown) {
        if (!isConstraintError(error)) throw error;
        return { success: false, error: "Payment is already being processed. Please retry shortly." };
      }
    }

    let paymentApplied = false;
    for (let attempt = 0; attempt < PAYMENT_CONFIRMATION_MAX_CAS_ATTEMPTS; attempt += 1) {
      // ── 1. Fetch the latest order version for a CAS-safe amount update ──
      const order = attempt === 0
        ? initialOrder
        : await db
          .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
            paymentStatus: orders.paymentStatus,
            status: orders.status,
            inventoryPool: orders.inventoryPool,
            version: orders.version,
            deletedAt: orders.deletedAt,
          })
          .from(orders)
          .where(eq(orders.id, params.orderId))
          .get();

      if (!order) {
        return { success: false, error: `Order ${params.orderId} not found` };
      }

      const unpayableReason = getUnpayableOrderReason(order);
      if (unpayableReason) {
        return { success: false, error: unpayableReason, retryable: false };
      }

      const newPaidAmount = roundPrice((order.paidAmount ?? 0) + params.amount);
      const newBalanceDue = roundPrice(Math.max(0, order.totalAmount - newPaidAmount));
      const isFullyPaid = pricesEqual(newBalanceDue, 0);
      const newPaymentStatus = isFullyPaid ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
      const newStatus = order.status === OrderStatus.INCOMPLETE ? OrderStatus.PENDING : order.status;

      validateTransition("order", order.status, newStatus);
      validateTransition("payment", order.paymentStatus, newPaymentStatus);

      const nextVersion = order.version + 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch statements are heterogeneous.
      const batchStatements: any[] = [
        db.update(orders).set({
          status: newStatus,
          paidAmount: newPaidAmount,
          balanceDue: newBalanceDue,
          paymentStatus: newPaymentStatus,
          version: nextVersion,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orders.id, params.orderId),
          eq(orders.version, order.version),
          isNull(orders.deletedAt),
          notInArray(orders.status, [...PAYMENT_BLOCKED_ORDER_STATUSES]),
          notInArray(orders.paymentStatus, [...PAYMENT_BLOCKED_PAYMENT_STATUSES]),
          sql`EXISTS (
            SELECT 1 FROM order_payments
            WHERE id = ${paymentId}
              AND order_id = ${params.orderId}
              AND status IN ('pending', 'failed')
          )`,
        )).returning({ id: orders.id }),
        db.update(orderPayments).set({
          amount: params.amount,
          currency: currencyConfig.code,
          paymentMethod: params.paymentGateway,
          paymentType: params.paymentType,
          status: PaymentRecordStatus.SUCCEEDED,
          stripeChargeId: params.stripeChargeId ?? null,
          sslcommerzValId: params.sslcommerzValId ?? null,
          sslcommerzBankTranId: params.sslcommerzBankTranId ?? null,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orderPayments.id, paymentId),
          eq(orderPayments.orderId, params.orderId),
          inArray(orderPayments.status, [PaymentRecordStatus.PENDING, PaymentRecordStatus.FAILED]),
          sql`EXISTS (
            SELECT 1 FROM orders
            WHERE id = ${params.orderId}
              AND version = ${nextVersion}
              AND paid_amount = ${newPaidAmount}
              AND balance_due = ${newBalanceDue}
              AND payment_status = ${newPaymentStatus}
          )`,
        )).returning({ id: orderPayments.id }),
      ];

      if (params.paymentType === "deposit") {
        batchStatements.push(
          db
            .update(paymentPlans)
            .set({
              status: "deposit_paid",
              depositPaidAt: sql`unixepoch()`,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(paymentPlans.orderId, params.orderId)),
        );
      } else if (params.paymentType === "balance" && isFullyPaid) {
        batchStatements.push(
          db
            .update(paymentPlans)
            .set({
              status: "fully_paid",
              balancePaidAt: sql`unixepoch()`,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(paymentPlans.orderId, params.orderId)),
        );
      }

      const batchResult = await db.batch(batchStatements as any) as unknown[];
      const orderUpdate = batchResult[0] as Array<{ id: string }> | undefined;
      const paymentUpdate = batchResult[1] as Array<{ id: string }> | undefined;

      if ((orderUpdate?.length ?? 0) === 0 && (paymentUpdate?.length ?? 0) === 0) {
        continue;
      }
      if ((orderUpdate?.length ?? 0) === 0 || (paymentUpdate?.length ?? 0) === 0) {
        return { success: false, error: "Payment application changed concurrently; retry required" };
      }

      paymentApplied = true;
      break;
    }

    if (!paymentApplied) {
      return { success: false, error: "Order was modified concurrently while applying payment; retry required" };
    }

    return { success: true };
  } catch (err: unknown) {
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
    if (intentId) {
      const existing = await db
        .select({ id: orderPayments.id, status: orderPayments.status })
        .from(orderPayments)
        .where(and(
          eq(orderPayments.orderId, orderId),
          gateway === "stripe"
            ? eq(orderPayments.stripePaymentIntentId, intentId)
            : gateway === "sslcommerz"
              ? eq(orderPayments.sslcommerzTranId, intentId)
              : eq(orderPayments.polarCheckoutId, intentId),
        ))
        .get();

      if (existing?.status === PaymentRecordStatus.FAILED || existing?.status === PaymentRecordStatus.SUCCEEDED) {
        return;
      }
      if (existing?.status === PaymentRecordStatus.PENDING) {
        await db
          .update(orderPayments)
          .set({
            status: PaymentRecordStatus.FAILED,
            updatedAt: sql`unixepoch()`,
          })
          .where(and(
            eq(orderPayments.id, existing.id),
            eq(orderPayments.status, PaymentRecordStatus.PENDING),
          ));
        return;
      }
    }

    const order = await db
      .select({
        paidAmount: orders.paidAmount,
        paymentStatus: orders.paymentStatus,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();

    if (!order) return;
    assertNoActiveShipmentClaim(order);

    const currencyConfig = await getCurrencyConfig(db);
    try {
      await db.insert(orderPayments).values({
        id: crypto.randomUUID(),
        orderId,
        amount: 0,
        currency: currencyConfig.code,
        paymentMethod: gateway,
        paymentType: "full",
        status: PaymentRecordStatus.FAILED,
        stripePaymentIntentId: gateway === "stripe" ? (intentId ?? null) : null,
        sslcommerzTranId: gateway === "sslcommerz" ? (intentId ?? null) : null,
        polarCheckoutId: gateway === "polar" ? (intentId ?? null) : null,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      });
    } catch (error: unknown) {
      if (intentId && isConstraintError(error)) return;
      throw error;
    }

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
  } catch (err: unknown) {
    console.error(`[process-payment] Failed payment recording error:`, err);
    throw err;
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
      .select({
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();
    if (order) assertNoActiveShipmentClaim(order);
    await applyInventoryForStatusChange(db, orderId, OrderStatus.CANCELLED);
  } catch (err: unknown) {
    console.error(`[process-payment] Inventory release error for order ${orderId}:`, err);
    throw err;
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
      processedAt: sql`unixepoch()`,
    });
  } catch {
    // Duplicate key = already recorded — safe to ignore
  }
}
