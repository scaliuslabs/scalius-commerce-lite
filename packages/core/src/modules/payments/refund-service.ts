// src/modules/payments/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Determines the correct payment gateway from the order's payment records
// and dispatches the refund via the unified PaymentProvider interface.

import { eq, sql, desc, and } from "drizzle-orm";
import { orders, orderPayments, PaymentStatus, OrderStatus } from "@scalius/database/schema";
import { createPaymentProvider } from "./factory";
import { getStripeSettings, getSSLCommerzSettings, getPolarSettings } from "./gateway-settings";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import type { Database } from "@scalius/database/client";
import type { PaymentGateway } from "./types";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { roundPrice } from "@scalius/shared/price-utils";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCurrencyConfig } from "../settings/settings.service";
import { canTransitionTo } from "../orders/order-state-machine";

export interface RefundRequest {
    orderId: string;
    /** Amount to refund. If omitted, full refund of paidAmount. */
    amount?: number;
    reason: string;
    /** Override gateway detection (useful for multi-gateway orders) */
    gateway?: "stripe" | "sslcommerz" | "polar" | "cod";
}

export interface RefundResult {
    success: boolean;
    gateway: string;
    refundId?: string;
    amount: number;
    isFullRefund: boolean;
    error?: string;
}

// ---------------------------------------------------------------------------
// Gateway transaction ID resolution
// ---------------------------------------------------------------------------

/** Extract the correct gateway-specific transaction ID from a payment record. */
function getTransactionId(
    gateway: PaymentGateway,
    payment: { stripeChargeId?: string | null; sslcommerzBankTranId?: string | null; polarCheckoutId?: string | null },
): string {
    switch (gateway) {
        case "stripe": {
            if (!payment.stripeChargeId) throw new ValidationError("No Stripe charge ID found on payment record");
            return payment.stripeChargeId;
        }
        case "sslcommerz": {
            if (!payment.sslcommerzBankTranId) throw new ValidationError("No SSLCommerz bank_tran_id found on payment record");
            return payment.sslcommerzBankTranId;
        }
        case "polar": {
            if (!payment.polarCheckoutId) throw new ValidationError("No Polar order ID found on payment record");
            return payment.polarCheckoutId;
        }
        case "cod":
            return `COD-${Date.now()}`;
        default:
            throw new ValidationError(`Unsupported payment gateway: ${gateway}`);
    }
}

// ---------------------------------------------------------------------------
// Resolve gateway settings and create provider
// ---------------------------------------------------------------------------

async function resolveProvider(
    db: Database,
    kv: KVNamespace | undefined,
    gateway: PaymentGateway,
    encryptionKey?: string,
) {
    switch (gateway) {
        case "stripe": {
            const settings = await getStripeSettings(db, kv, encryptionKey);
            if (!settings) throw new ServiceUnavailableError("Stripe is not configured");
            return createPaymentProvider({ type: "stripe", settings });
        }
        case "sslcommerz": {
            const settings = await getSSLCommerzSettings(db, kv, encryptionKey);
            if (!settings) throw new ServiceUnavailableError("SSLCommerz is not configured");
            return createPaymentProvider({ type: "sslcommerz", settings });
        }
        case "polar": {
            const settings = await getPolarSettings(db, kv, encryptionKey);
            if (!settings) throw new ServiceUnavailableError("Polar is not configured");
            return createPaymentProvider({ type: "polar", settings });
        }
        case "cod":
            return createPaymentProvider({ type: "cod", db });
        default:
            throw new ValidationError(`Unsupported payment gateway: ${gateway}`);
    }
}

// ---------------------------------------------------------------------------
// Unified refund dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a refund through the unified PaymentProvider interface.
 * Returns the gateway-assigned refund ID.
 *
 * Amount conventions per gateway (matching RefundParams contract):
 *   - Stripe & Polar: smallest currency unit (cents/paisa)
 *   - SSLCommerz: major units (the provider passes through to SSLCommerz API)
 *   - COD: no external amount needed
 */
async function dispatchRefund(
    db: Database,
    kv: KVNamespace | undefined,
    gateway: PaymentGateway,
    payment: { stripeChargeId?: string | null; sslcommerzBankTranId?: string | null; polarCheckoutId?: string | null },
    refundAmount: number,
    isFullRefund: boolean,
    currencyDecimals: number,
    params: RefundRequest,
    encryptionKey?: string,
): Promise<string | undefined> {
    const transactionId = getTransactionId(gateway, payment);
    const provider = await resolveProvider(db, kv, gateway, encryptionKey);

    // Determine the correct amount for each gateway's convention:
    // Stripe & Polar expect smallest currency unit; SSLCommerz expects major units.
    let providerAmount: number | undefined;
    if (!isFullRefund) {
        if (gateway === "stripe" || gateway === "polar") {
            providerAmount = Math.round(refundAmount * Math.pow(10, currencyDecimals));
        } else {
            // SSLCommerz and COD use major units
            providerAmount = refundAmount;
        }
    }

    const result = await provider.createRefund({
        transactionId,
        amount: providerAmount,
        reason: params.reason,
    });

    return result.refundId;
}

/**
 * Process a refund for an order.
 *
 * 1. Finds the payment record (or uses specified gateway)
 * 2. Dispatches to the correct gateway API via PaymentProvider
 * 3. Updates order payment status
 * 4. Releases inventory on full refund
 */
export async function processRefund(
    db: Database,
    kv: KVNamespace | undefined,
    params: RefundRequest,
    encryptionKey?: string,
): Promise<RefundResult> {
    // 1. Fetch order (include version for CAS to prevent concurrent refund races)
    const order = await db
        .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            status: orders.status,
            version: orders.version,
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

    // 2. Find the latest successful payment (filter out failed/refunded)
    const payment = await db
        .select()
        .from(orderPayments)
        .where(
            and(
                eq(orderPayments.orderId, params.orderId),
                eq(orderPayments.status, "succeeded"),
            ),
        )
        .orderBy(desc(orderPayments.createdAt))
        .get();

    if (!payment) {
        throw new NotFoundError("No payment record found for this order");
    }

    const gateway = params.gateway ?? payment.paymentMethod;

    // Get currency decimals for smallest-unit conversion (Stripe/Polar)
    const currencyConfig = await getCurrencyConfig(db, kv);
    const currencyDecimals = getDecimalPlaces(currencyConfig.code);

    // 3. Dispatch to gateway via unified PaymentProvider interface
    const refundId = await dispatchRefund(
        db, kv, gateway as PaymentGateway, payment, refundAmount, isFullRefund, currencyDecimals, params, encryptionKey
    );

    // 4. Record refund in orderPayments + update order atomically
    const refundPaymentId = crypto.randomUUID();
    const newPaidAmount = roundPrice(Math.max(0, (order.paidAmount ?? 0) - refundAmount));

    // Determine new order status based on refund type and state machine constraints.
    // Only delivered, completed, and partially_refunded can transition to refunded/partially_refunded.
    const orderStatusUpdate: Record<string, unknown> = {};
    if (isFullRefund && canTransitionTo("order", order.status, OrderStatus.REFUNDED)) {
        orderStatusUpdate.status = OrderStatus.REFUNDED;
    } else if (!isFullRefund && canTransitionTo("order", order.status, OrderStatus.PARTIALLY_REFUNDED)) {
        orderStatusUpdate.status = OrderStatus.PARTIALLY_REFUNDED;
    }

    // CAS: Use version to prevent concurrent refund races. If another refund
    // modified this order between our read and this write, the WHERE clause
    // won't match and the order update silently applies to 0 rows.
    const nextVersion = order.version + 1;

    await db.batch([
        db.insert(orderPayments).values({
            id: refundPaymentId,
            orderId: params.orderId,
            amount: refundAmount,
            currency: currencyConfig.code,
            paymentMethod: gateway,
            paymentType: "refund",
            status: "refunded",
            // Refund records must NOT copy the original payment's unique gateway IDs —
            // partial unique indexes (e.g., UNIQUE(orderId, stripePaymentIntentId))
            // would reject the insert. Refund is identified by metadata.refundId instead.
            stripeChargeId: payment.stripeChargeId,
            metadata: JSON.stringify({ refundId, reason: params.reason }),
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
        db.update(orders).set({
            paidAmount: newPaidAmount,
            paymentStatus: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL,
            version: nextVersion,
            ...orderStatusUpdate,
            updatedAt: sql`unixepoch()`,
        }).where(and(eq(orders.id, params.orderId), eq(orders.version, order.version))),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);

    // Verify CAS succeeded — if version didn't advance, a concurrent refund beat us.
    // The refund payment record was inserted but the order wasn't updated, which is
    // inconsistent. We must clean up the orphaned refund record and fail.
    const postOrder = await db
        .select({ version: orders.version })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (postOrder && postOrder.version !== nextVersion) {
        // CAS failed: another refund modified the order concurrently.
        // Remove the orphaned refund payment record we just inserted.
        await db.delete(orderPayments).where(eq(orderPayments.id, refundPaymentId));
        throw new ConflictError(
            "Refund failed due to a concurrent modification. Please retry."
        );
    }

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
    },
    encryptionKey?: string,
): Promise<{ refundResult?: RefundResult }> {
    // Verify order exists and is in a returnable state (include version for CAS)
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            version: orders.version,
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

    // NOTE: Inventory is applied before the CAS batch update. If the CAS check fails
    // (concurrent modification), inventory changes will have already been applied.
    // This is a known limitation — fully fixing it requires refactoring inventory
    // operations into the batch. The CAS check below mitigates the most common race.
    const newInventoryAction = await applyInventoryForStatusChange(db, params.orderId, OrderStatus.RETURNED);

    // CAS update: only proceed if the order version hasn't changed since we read it.
    // Prevents concurrent modifications from overwriting each other.
    await db.batch([
        db.update(orders).set({
            status: OrderStatus.RETURNED,
            version: order.version + 1,
            inventoryAction: newInventoryAction,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, params.orderId),
            eq(orders.version, order.version),
        )),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);

    // Auto-refund if requested and order has payments
    let refundResult: RefundResult | undefined;
    if (params.autoRefund && order.paymentStatus !== PaymentStatus.UNPAID && order.paymentStatus !== PaymentStatus.REFUNDED) {
        refundResult = await processRefund(db, kv, {
            orderId: params.orderId,
            reason: params.reason,
        }, encryptionKey);
    }

    return { refundResult };
}
