// src/modules/payments/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Determines the correct payment gateway from the order's payment records
// and dispatches the refund to either Stripe or SSLCommerz.

import { eq, sql, desc, and } from "drizzle-orm";
import { orders, orderPayments, PaymentStatus, OrderStatus } from "@scalius/database/schema";
import { createRefund as stripeRefund } from "./stripe";
import { initiateSSLCommerzRefund } from "./sslcommerz";
import { createPolarRefund } from "./polar";
import { getStripeSettings, getSSLCommerzSettings, getPolarSettings } from "./gateway-settings";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { roundPrice } from "@scalius/shared/price-utils";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCurrencyConfig } from "../settings/settings.service";

export interface RefundRequest {
    orderId: string;
    /** Amount to refund. If omitted, full refund of paidAmount. */
    amount?: number;
    reason: string;
    /** Override gateway detection (useful for multi-gateway orders) */
    gateway?: "stripe" | "sslcommerz" | "polar";
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
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }

    if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
        throw new ValidationError("Order has no payments to refund");
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
        throw new ConflictError("Order is already fully refunded");
    }

    // Determine and validate refund amount before any gateway calls
    const paidAmount = order.paidAmount ?? 0;
    const refundAmount = roundPrice(params.amount ?? (order.paidAmount ?? order.totalAmount));

    if (refundAmount <= 0) {
        throw new ValidationError("Refund amount must be greater than zero");
    }

    if (refundAmount > paidAmount) {
        throw new ValidationError(
            `Refund amount (${refundAmount}) exceeds paid amount (${paidAmount})`
        );
    }

    // Check cumulative refunds already issued against this order
    const alreadyRefundedRow = await db
        .select({ total: sql<number>`COALESCE(SUM(${orderPayments.amount}), 0)` })
        .from(orderPayments)
        .where(
            and(
                eq(orderPayments.orderId, params.orderId),
                eq(orderPayments.status, "refunded")
            )
        )
        .get();

    const totalAlreadyRefunded = alreadyRefundedRow?.total ?? 0;

    if (totalAlreadyRefunded + refundAmount > paidAmount) {
        throw new ValidationError(
            `Refund of ${refundAmount} would exceed the remaining refundable amount. ` +
            `Already refunded: ${totalAlreadyRefunded}, paid: ${paidAmount}`
        );
    }

    const isFullRefund = refundAmount >= paidAmount;

    // 2. Find the latest successful payment
    const payment = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, params.orderId))
        .orderBy(desc(orderPayments.createdAt))
        .get();

    if (!payment) {
        throw new NotFoundError("No payment record found for this order");
    }

    const gateway = params.gateway ?? payment.paymentMethod;

    // Get currency decimals for smallest-unit conversion (Stripe/Polar)
    const currencyConfig = await getCurrencyConfig(db, kv);
    const currencyDecimals = getDecimalPlaces(currencyConfig.code);

    // 3. Dispatch to gateway
    let refundId: string | undefined;

    if (gateway === "stripe") {
        if (!payment.stripeChargeId) {
            throw new ValidationError("No Stripe charge ID found on payment record");
        }

        const stripe = await getStripeSettings(db, kv);
        if (!stripe) {
            throw new ServiceUnavailableError("Stripe is not configured");
        }

        const result = await stripeRefund(
            stripe.secretKey,
            payment.stripeChargeId,
            isFullRefund ? undefined : Math.round(refundAmount * Math.pow(10, currencyDecimals)), // Stripe uses smallest unit
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
            throw new ValidationError("No SSLCommerz bank_tran_id found on payment record");
        }

        const ssl = await getSSLCommerzSettings(db, kv);
        if (!ssl) {
            throw new ServiceUnavailableError("SSLCommerz is not configured");
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
    } else if (gateway === "polar") {
        if (!payment.polarCheckoutId) {
            throw new ValidationError("No Polar order ID found on payment record");
        }

        const polar = await getPolarSettings(db, kv);
        if (!polar) {
            throw new ServiceUnavailableError("Polar is not configured");
        }

        const result = await createPolarRefund(
            polar,
            {
                polarOrderId: payment.polarCheckoutId,
                amount: Math.round(refundAmount * Math.pow(10, currencyDecimals)),
                reason: params.reason === "duplicate" ? "duplicate"
                    : params.reason === "fraudulent" ? "fraudulent"
                        : "customer_request"
            }
        );

        if (!result.success) {
            return { success: false, gateway, amount: refundAmount, isFullRefund, error: result.error };
        }
        refundId = result.refundId;
    } else if (gateway === "cod") {
        // COD "refund" is just a status update — no gateway API call needed
        refundId = `COD-REFUND-${Date.now()}`;
    } else {
        throw new ValidationError(`Unsupported payment gateway: ${gateway}`);
    }

    // 4. Update order payment status
    const newPaidAmount = roundPrice(Math.max(0, (order.paidAmount ?? 0) - refundAmount));
    await db
        .update(orders)
        .set({
            paidAmount: newPaidAmount,
            paymentStatus: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, params.orderId));

    // 5. Handle inventory on full refund:
    //    - If still reserved (pre-ship): release reservations
    //    - If already deducted (shipped): do NOT auto-restore (admin must manually adjust)
    // Note: partial refunds intentionally do NOT restore inventory — a partial refund
    // does not imply the items were returned. Inventory is only restored on full refund
    // or via the explicit return flow (processReturn).
    if (isFullRefund) {
        await applyInventoryForStatusChange(db, params.orderId, "cancelled");
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
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }

    const returnableStatuses: string[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.SHIPPED];
    if (!returnableStatuses.includes(order.status)) {
        throw new ValidationError(
            `Cannot return an order in '${order.status}' status. Order must be delivered, completed, or shipped.`
        );
    }

    // Always restore inventory on return (idempotent — safe to call multiple times)
    await applyInventoryForStatusChange(db, params.orderId, OrderStatus.RETURNED);

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
