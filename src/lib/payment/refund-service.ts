// src/lib/payment/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Determines the correct payment gateway from the order's payment records
// and dispatches the refund to either Stripe or SSLCommerz.

import { eq, sql, desc } from "drizzle-orm";
import { orders, orderPayments, PaymentStatus, OrderStatus } from "@/db/schema";
import { createRefund as stripeRefund } from "./stripe";
import { initiateSSLCommerzRefund } from "./sslcommerz";
import { getStripeSettings, getSSLCommerzSettings } from "./gateway-settings";
import { releaseOrderInventory } from "./process-payment";
import type { Database } from "@/db";

export interface RefundRequest {
    orderId: string;
    /** Amount to refund. If omitted, full refund of paidAmount. */
    amount?: number;
    reason: string;
    /** Override gateway detection (useful for multi-gateway orders) */
    gateway?: "stripe" | "sslcommerz";
}

export interface RefundResult {
    success: boolean;
    gateway: string;
    refundId?: string;
    amount: number;
    isFullRefund: boolean;
    error?: string;
}

/**
 * Process a refund for an order.
 *
 * 1. Finds the payment record (or uses specified gateway)
 * 2. Dispatches to the correct gateway API
 * 3. Updates order payment status
 * 4. Releases inventory on full refund
 */
export async function processRefund(
    db: Database,
    kv: KVNamespace | undefined,
    params: RefundRequest
): Promise<RefundResult> {
    // 1. Fetch order
    const order = await db
        .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            status: orders.status,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        return { success: false, gateway: "unknown", amount: 0, isFullRefund: false, error: "Order not found" };
    }

    if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
        return { success: false, gateway: "unknown", amount: 0, isFullRefund: false, error: "Order has no payments to refund" };
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
        return { success: false, gateway: "unknown", amount: 0, isFullRefund: false, error: "Order is already fully refunded" };
    }

    // 2. Find the latest successful payment
    const payment = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, params.orderId))
        .orderBy(desc(orderPayments.createdAt))
        .get();

    if (!payment) {
        return { success: false, gateway: "unknown", amount: 0, isFullRefund: false, error: "No payment record found" };
    }

    const gateway = params.gateway ?? payment.paymentMethod;
    const refundAmount = params.amount ?? (order.paidAmount ?? order.totalAmount);
    const isFullRefund = refundAmount >= (order.paidAmount ?? order.totalAmount);

    // 3. Dispatch to gateway
    let refundId: string | undefined;

    if (gateway === "stripe") {
        if (!payment.stripeChargeId) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: "No Stripe charge ID found on payment record" };
        }

        const stripe = await getStripeSettings(db, kv);
        if (!stripe) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: "Stripe is not configured" };
        }

        const result = await stripeRefund(
            stripe.secretKey,
            payment.stripeChargeId,
            isFullRefund ? undefined : Math.round(refundAmount * 100), // Stripe uses smallest unit
            params.reason === "duplicate" ? "duplicate"
                : params.reason === "fraudulent" ? "fraudulent"
                    : "requested_by_customer"
        );

        if (!result.success) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: result.error };
        }
        refundId = result.refundId;
    } else if (gateway === "sslcommerz") {
        if (!payment.sslcommerzBankTranId) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: "No SSLCommerz bank_tran_id found on payment record" };
        }

        const ssl = await getSSLCommerzSettings(db, kv);
        if (!ssl) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: "SSLCommerz is not configured" };
        }

        const refundTranId = `REF-${params.orderId}-${Date.now()}`;
        const result = await initiateSSLCommerzRefund(
            ssl.storeId,
            ssl.storePassword,
            ssl.sandbox,
            {
                bankTranId: payment.sslcommerzBankTranId,
                refundAmount,
                refundRemarks: params.reason,
                refundTranId,
            }
        );

        if (!result.success) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: result.error };
        }
        refundId = result.refundRefId ?? refundTranId;
    } else if (gateway === "cod") {
        // COD "refund" is just a status update — no gateway API call needed
        refundId = `COD-REFUND-${Date.now()}`;
    } else {
        return { success: false, gateway, amount: refundAmount, isFullRefund, error: `Unsupported gateway: ${gateway}` };
    }

    // 4. Update order payment status
    const newPaidAmount = Math.max(0, (order.paidAmount ?? 0) - refundAmount);
    await db
        .update(orders)
        .set({
            paidAmount: newPaidAmount,
            paymentStatus: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, params.orderId));

    // 5. Release inventory on full refund
    if (isFullRefund) {
        await releaseOrderInventory(db, params.orderId);
    }

    return {
        success: true,
        gateway,
        refundId,
        amount: refundAmount,
        isFullRefund,
    };
}

/**
 * Process an order return.
 *
 * Sets order status to RETURNED and optionally triggers a refund.
 */
export async function processReturn(
    db: Database,
    kv: KVNamespace | undefined,
    params: {
        orderId: string;
        reason: string;
        autoRefund: boolean;
    }
): Promise<{ success: boolean; refundResult?: RefundResult; error?: string }> {
    // Verify order exists and is in a returnable state
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        return { success: false, error: "Order not found" };
    }

    const returnableStatuses = [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.SHIPPED];
    if (!returnableStatuses.includes(order.status as any)) {
        return {
            success: false,
            error: `Cannot return an order in '${order.status}' status. Order must be delivered, completed, or shipped.`,
        };
    }

    // Set order status to RETURNED
    await db
        .update(orders)
        .set({
            status: OrderStatus.RETURNED,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, params.orderId));

    // Auto-refund if requested and order has payments
    let refundResult: RefundResult | undefined;
    if (params.autoRefund && order.paymentStatus !== PaymentStatus.UNPAID && order.paymentStatus !== PaymentStatus.REFUNDED) {
        refundResult = await processRefund(db, kv, {
            orderId: params.orderId,
            reason: params.reason,
        });
    }

    return { success: true, refundResult };
}
