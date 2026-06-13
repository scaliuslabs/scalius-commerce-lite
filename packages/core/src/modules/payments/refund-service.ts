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
import { assertNoActiveShipmentClaim } from "../orders/shipment-claim";

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

const REFUND_IN_PROGRESS_MESSAGE = "A refund is already in progress for this order. Please wait and retry.";
const PRE_FULFILLMENT_REFUND_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);

function getRefundClaimId(orderId: string, orderVersion: number): string {
    return `refund_${orderId}_${orderVersion}`;
}

function isConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /constraint|unique|primary key/i.test(message);
}

function getOrderStatusAfterRefund(currentStatus: string, isFullRefund: boolean): string | undefined {
    if (!isFullRefund) {
        return canTransitionTo("order", currentStatus, OrderStatus.PARTIALLY_REFUNDED)
            ? OrderStatus.PARTIALLY_REFUNDED
            : undefined;
    }

    if (canTransitionTo("order", currentStatus, OrderStatus.REFUNDED)) {
        return OrderStatus.REFUNDED;
    }

    if (
        PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus) &&
        canTransitionTo("order", currentStatus, OrderStatus.CANCELLED)
    ) {
        return OrderStatus.CANCELLED;
    }

    return undefined;
}

function shouldReleaseInventoryForFullRefund(currentStatus: string, nextStatus: string | undefined): boolean {
    return nextStatus === OrderStatus.CANCELLED && PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus);
}

async function updateOrderStatusIfVersionMatches(
    db: Database,
    params: {
        orderId: string;
        nextStatus: string;
        expectedVersion: number;
    },
): Promise<boolean> {
    const result = await db
        .update(orders)
        .set({
            status: params.nextStatus,
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, params.orderId),
            eq(orders.version, params.expectedVersion),
        ))
        .returning({ id: orders.id });

    return result.length > 0;
}

async function assertNoPendingRefund(db: Database, orderId: string): Promise<void> {
    const pendingRefund = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(
            and(
                eq(orderPayments.orderId, orderId),
                eq(orderPayments.paymentType, "refund"),
                eq(orderPayments.status, "pending"),
            ),
        )
        .get();

    if (pendingRefund) {
        throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
    }
}

async function releaseRefundClaim(
    db: Database,
    params: {
        orderId: string;
        refundPaymentId: string;
        refundAmount: number;
        originalPaymentStatus: string;
        reason: string;
        gateway: PaymentGateway;
        error: unknown;
    },
): Promise<void> {
    const message = params.error instanceof Error ? params.error.message : String(params.error);

    await db.batch([
        db.update(orderPayments).set({
            status: "failed",
            metadata: JSON.stringify({
                reason: params.reason,
                gateway: params.gateway,
                error: message,
                failedAt: new Date().toISOString(),
            }),
            updatedAt: sql`unixepoch()`,
        }).where(eq(orderPayments.id, params.refundPaymentId)),
        db.update(orders).set({
            paidAmount: sql`${orders.paidAmount} + ${params.refundAmount}`,
            paymentStatus: params.originalPaymentStatus,
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(eq(orders.id, params.orderId)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);
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
    payment: { stripeChargeId?: string | null; sslcommerzBankTranId?: string | null; polarCheckoutId?: string | null; metadata?: string | null },
    refundAmount: number,
    isFullRefund: boolean,
    currencyDecimals: number,
    params: RefundRequest,
    encryptionKey?: string,
): Promise<string | undefined> {
    const transactionId = getTransactionId(gateway, payment);
    const provider = await resolveProvider(db, kv, gateway, encryptionKey);

    // Determine the correct amount for each gateway's convention:
    // Stripe: smallest currency unit, undefined = full refund
    // Polar: smallest currency unit, always requires explicit positive amount
    // SSLCommerz/COD: major units, always required
    let providerAmount: number | undefined;
    if (gateway === "stripe") {
        // Stripe accepts undefined for full refund
        if (!isFullRefund) {
            providerAmount = Math.round(refundAmount * Math.pow(10, currencyDecimals));
        }
    } else if (gateway === "polar") {
        // Polar ALWAYS requires an explicit positive amount (no "refund all" shorthand).
        // If the payment used currency conversion (e.g. BDT→USD), convert the
        // store-currency refund amount to gateway currency using the stored rate.
        let gatewayRefundAmount = refundAmount;
        let gatewayDecimals = currencyDecimals;

        if (payment.metadata) {
            try {
                const meta = typeof payment.metadata === "string"
                    ? JSON.parse(payment.metadata)
                    : payment.metadata;
                const storedRate = parseFloat(meta?.exchangeRate);
                const gatewayCurrency = meta?.gatewayCurrency;
                if (storedRate && storedRate !== 1 && gatewayCurrency) {
                    gatewayRefundAmount = Math.round((refundAmount / storedRate) * 100) / 100;
                    gatewayDecimals = getDecimalPlaces(gatewayCurrency);
                }
            } catch { /* metadata parse failed — use store currency as-is */ }
        }

        providerAmount = Math.round(gatewayRefundAmount * Math.pow(10, gatewayDecimals));
    } else {
        // SSLCommerz and COD: always pass the explicit amount in major units
        providerAmount = refundAmount;
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
 * 2. Claims refund capacity locally before provider dispatch
 * 3. Dispatches to the correct gateway API via PaymentProvider
 * 4. Finalizes order payment status
 * 5. Releases inventory on full refund
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
            inventoryAction: orders.inventoryAction,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    assertNoActiveShipmentClaim(order);

    if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
        throw new ValidationError("Order has no payments to refund");
    }

    if (
        order.paymentStatus === PaymentStatus.REFUNDED &&
        order.status === OrderStatus.CANCELLED &&
        order.inventoryAction !== "deducted"
    ) {
        await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
        return {
            success: true,
            gateway: params.gateway ?? order.paymentMethod,
            amount: 0,
            isFullRefund: true,
        };
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
        throw new ConflictError("Order is already fully refunded");
    }

    await assertNoPendingRefund(db, params.orderId);

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

    const newPaidAmount = roundPrice(Math.max(0, (order.paidAmount ?? 0) - refundAmount));
    const newPaymentStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL;
    const refundPaymentId = getRefundClaimId(params.orderId, order.version);
    const claimVersion = order.version + 1;

    // 3. Claim refund capacity locally before calling the gateway. The deterministic
    // refund ID and order-version CAS ensure that concurrent callers cannot both
    // pass this point and hit the external provider.
    let claimResults: [unknown, Array<{ id: string; version: number }>];
    try {
        claimResults = await db.batch([
            db.insert(orderPayments).values({
                id: refundPaymentId,
                orderId: params.orderId,
                amount: refundAmount,
                currency: currencyConfig.code,
                paymentMethod: gateway,
                paymentType: "refund",
                status: "pending",
                metadata: JSON.stringify({
                    reason: params.reason,
                    gateway,
                    claimVersion,
                    claimedAt: new Date().toISOString(),
                }),
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
            db.update(orders).set({
                paidAmount: newPaidAmount,
                paymentStatus: newPaymentStatus,
                version: claimVersion,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, params.orderId),
                eq(orders.version, order.version),
                sql`${orders.paidAmount} >= ${refundAmount}`,
            )).returning({ id: orders.id, version: orders.version }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ] as any) as any;
    } catch (error: unknown) {
        if (isConstraintError(error)) {
            throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
        }
        throw error;
    }

    const claimedOrder = claimResults[1]?.[0];
    if (!claimedOrder) {
        await db.delete(orderPayments).where(eq(orderPayments.id, refundPaymentId));
        throw new ConflictError(
            "Refund failed due to a concurrent modification. Please retry."
        );
    }

    // 4. Dispatch to gateway via unified PaymentProvider interface after the
    // local claim succeeds. If the provider rejects the refund, release the
    // reserved paid amount and mark the claim failed.
    let refundId: string | undefined;
    try {
        refundId = await dispatchRefund(
            db, kv, gateway as PaymentGateway, payment, refundAmount, isFullRefund, currencyDecimals, params, encryptionKey
        );
    } catch (error: unknown) {
        await releaseRefundClaim(db, {
            orderId: params.orderId,
            refundPaymentId,
            refundAmount,
            originalPaymentStatus: order.paymentStatus,
            reason: params.reason,
            gateway: gateway as PaymentGateway,
            error,
        });
        throw error;
    }

    await db.update(orderPayments).set({
        status: "refunded",
        // Refund records must NOT copy the original payment's unique gateway IDs —
        // partial unique indexes (e.g., UNIQUE(orderId, stripePaymentIntentId))
        // would reject the insert. Refund is identified by metadata.refundId instead.
        metadata: JSON.stringify({
            refundId,
            reason: params.reason,
            gateway,
            claimVersion,
            refundedAt: new Date().toISOString(),
        }),
        updatedAt: sql`unixepoch()`,
    }).where(eq(orderPayments.id, refundPaymentId));

    // Determine new order status based on refund type and state machine constraints.
    // Pre-fulfillment full refunds cancel the order and release reservations.
    // Fulfilled/returned full refunds mark payment/order as refunded without
    // restocking physical inventory; returns own that inventory transition.
    const nextOrderStatus = getOrderStatusAfterRefund(order.status, isFullRefund);
    let orderStatusChanged = false;

    if (nextOrderStatus) {
        orderStatusChanged = await updateOrderStatusIfVersionMatches(db, {
            orderId: params.orderId,
            nextStatus: nextOrderStatus,
            expectedVersion: claimedOrder.version,
        });

        if (!orderStatusChanged) {
            console.warn(
                `Skipping inventory transition for refunded order ${params.orderId}: order status changed concurrently.`,
            );
        }
    }

    // 5. Handle inventory on full refund:
    //    - Pre-fulfillment cancellation releases reserved stock.
    //    - Shipped/delivered/completed refunds do NOT auto-restore stock.
    //      Use the explicit return flow when merchandise comes back.
    if (isFullRefund && orderStatusChanged && shouldReleaseInventoryForFullRefund(order.status, nextOrderStatus)) {
        await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
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
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    assertNoActiveShipmentClaim(order);

    const returnableStatuses: string[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.SHIPPED];
    if (order.status !== OrderStatus.RETURNED && !returnableStatuses.includes(order.status)) {
        throw new ValidationError(
            `Cannot return an order in '${order.status}' status. Order must be delivered, completed, or shipped.`
        );
    }

    // CAS update first: only apply inventory if this request actually owns the
    // RETURNED transition. This prevents orphan stock restoration when a
    // concurrent status change wins the order version race.
    const orderStatusChanged = order.status === OrderStatus.RETURNED
        ? true
        : await updateOrderStatusIfVersionMatches(db, {
            orderId: params.orderId,
            nextStatus: OrderStatus.RETURNED,
            expectedVersion: order.version,
        });

    if (!orderStatusChanged) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }

    await applyInventoryForStatusChange(db, params.orderId, OrderStatus.RETURNED);

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
