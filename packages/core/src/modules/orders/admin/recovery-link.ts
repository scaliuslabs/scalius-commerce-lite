// Merchant-sendable payment recovery links for hosted-gateway orders.
import type { Database } from "@scalius/database/client";
import {
    orders,
    paymentSessionAttempts,
    orderPayments,
    paymentPlans,
    OrderStatus,
    PaymentPlanStatus,
    PaymentRecordStatus,
    PaymentStatus,
} from "@scalius/database/schema";
import { getPaymentGateway } from "../../payments/gateways/registry";
import { eq } from "drizzle-orm";
import { fromMinor } from "@scalius/shared/money";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import type { OrderPaymentRecoverySummary } from "../types";
import { hasActiveShipmentClaim } from "../shipment-claim";
import { createOrderReceiptToken, recordOrderReceipt } from "../receipts";
import {
    findLatestAttempt,
    isActivePaymentAttempt,
    buildPaymentRecoverySummary,
    isStalePaymentAttempt,
} from "./shared";

/** Buyer recovery links continue a hosted (redirect) gateway checkout. */
export type BuyerRecoveryPaymentMethod = string;
export type RecoveryLinkPaymentType = "full" | "deposit" | "balance";

export interface OrderPaymentRecoveryLink {
    orderId: string;
    receiptToken: string;
    tokenHash: string;
    expiresAt: number;
    gateway: BuyerRecoveryPaymentMethod;
    paymentType: RecoveryLinkPaymentType | null;
    depositAmount: number | null;
    paymentRecovery: OrderPaymentRecoverySummary;
}

export interface OrderPaymentRecoveryPreview {
    orderId: string;
    gateway: BuyerRecoveryPaymentMethod;
    paymentType: RecoveryLinkPaymentType | null;
    depositAmount: number | null;
    paymentRecovery: OrderPaymentRecoverySummary;
}

function isBuyerRecoveryPaymentMethod(method: string | null | undefined): method is BuyerRecoveryPaymentMethod {
    return getPaymentGateway(method)?.flow === "hosted";
}

function isRecoveryLinkPaymentType(value: string | null | undefined): value is RecoveryLinkPaymentType {
    return value === "full" || value === "deposit" || value === "balance";
}

async function resolveOrderPaymentRecoveryPreview(
    db: Database,
    orderId: string,
    options: { nowSeconds?: number } = {},
): Promise<OrderPaymentRecoveryPreview> {
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            paidAmountMinor: orders.paidAmountMinor,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            deletedAt: orders.deletedAt,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    if (order.deletedAt != null) {
        throw new ValidationError("Order is not eligible for hosted payment recovery.");
    }
    if (hasActiveShipmentClaim(order, nowSeconds)) {
        throw new ConflictError("Order has an active shipment creation in progress. Wait for shipment recovery to finish before issuing a payment recovery link.");
    }
    if (order.status !== OrderStatus.INCOMPLETE) {
        throw new ValidationError("Only incomplete hosted-payment orders can receive a buyer recovery link.");
    }
    if (!isBuyerRecoveryPaymentMethod(order.paymentMethod)) {
        throw new ValidationError("Order is not eligible for buyer hosted-payment recovery.");
    }
    if (
        order.paymentStatus !== PaymentStatus.UNPAID &&
        order.paymentStatus !== PaymentStatus.FAILED
    ) {
        throw new ValidationError("Order payment state is not eligible for hosted payment recovery.");
    }
    if (order.paidAmountMinor > 0) {
        throw new ValidationError("Order already has payment recorded and cannot receive a receipt recovery link.");
    }

    const [paymentAttempts, paymentRows, paymentPlan] = await Promise.all([
        db
            .select({
                orderId: paymentSessionAttempts.orderId,
                gateway: paymentSessionAttempts.gateway,
                paymentType: paymentSessionAttempts.paymentType,
                status: paymentSessionAttempts.status,
                attempts: paymentSessionAttempts.attempts,
                claimExpiresAt: paymentSessionAttempts.claimExpiresAt,
                createdAt: paymentSessionAttempts.createdAt,
                updatedAt: paymentSessionAttempts.updatedAt,
            })
            .from(paymentSessionAttempts)
            .where(eq(paymentSessionAttempts.orderId, orderId))
            .all(),
        db
            .select({
                status: orderPayments.status,
            })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, orderId))
            .all(),
        db
            .select({
                status: paymentPlans.status,
                depositAmountMinor: paymentPlans.depositAmountMinor,
            })
            .from(paymentPlans)
            .where(eq(paymentPlans.orderId, orderId))
            .get(),
    ]);

    const activeAttempt = findLatestAttempt(
        paymentAttempts,
        (attempt) => isActivePaymentAttempt(attempt, nowSeconds),
    );
    if (activeAttempt) {
        throw new ConflictError("Order has an active hosted payment setup in progress. Wait for payment setup to finish before issuing a recovery link.");
    }

    const paymentRecovery = buildPaymentRecoverySummary(order, paymentAttempts, nowSeconds);
    if (paymentRecovery.state === "processing" || paymentRecovery.activeProcessing) {
        throw new ConflictError("Order has an active hosted payment setup in progress. Wait for payment setup to finish before issuing a recovery link.");
    }
    if (paymentRecovery.state !== "awaiting_payment" && paymentRecovery.state !== "needs_attention") {
        throw new ValidationError("Order has no recoverable hosted payment issue.");
    }

    const hasUnsafePaymentEvidence = paymentRows.some((payment) =>
        payment.status === PaymentRecordStatus.PENDING ||
        payment.status === PaymentRecordStatus.CONFIRMED ||
        payment.status === PaymentRecordStatus.SUCCEEDED
    );
    if (hasUnsafePaymentEvidence) {
        throw new ValidationError("Order has payment activity that must be reconciled before issuing a recovery link.");
    }
    const hasFailedPaymentEvidence = paymentRows.some((payment) =>
        payment.status === PaymentRecordStatus.FAILED
    ) || paymentAttempts.some((attempt) =>
        attempt.status === "failed" || isStalePaymentAttempt(attempt, nowSeconds)
    );
    if (order.paymentStatus === PaymentStatus.FAILED && !hasFailedPaymentEvidence) {
        throw new ValidationError("Order needs failed payment evidence before issuing a recovery link.");
    }

    const latestAttempt = findLatestAttempt(
        paymentAttempts,
        (attempt) => attempt.gateway === order.paymentMethod && isRecoveryLinkPaymentType(attempt.paymentType),
    );
    const paymentType = isRecoveryLinkPaymentType(paymentRecovery.paymentType)
        ? paymentRecovery.paymentType
        : latestAttempt?.paymentType && isRecoveryLinkPaymentType(latestAttempt.paymentType)
            ? latestAttempt.paymentType
            : null;
    const depositAmount = paymentType === "deposit" &&
        paymentPlan?.status === PaymentPlanStatus.PENDING &&
        paymentPlan.depositAmountMinor > 0
        ? fromMinor(paymentPlan.depositAmountMinor, order.currencyDecimalPlaces)
        : null;

    return {
        orderId,
        gateway: order.paymentMethod,
        paymentType,
        depositAmount,
        paymentRecovery,
    };
}

export async function previewOrderPaymentRecoveryLink(
    db: Database,
    orderId: string,
    options: { nowSeconds?: number } = {},
): Promise<OrderPaymentRecoveryPreview> {
    return resolveOrderPaymentRecoveryPreview(db, orderId, options);
}

/**
 * Issues a fresh private receipt proof for an unpaid SSLCommerz order
 * whose hosted payment flow can still be recovered from the receipt page.
 */
export async function createOrderPaymentRecoveryLink(
    db: Database,
    orderId: string,
    options: { nowSeconds?: number; source?: string } = {},
): Promise<OrderPaymentRecoveryLink> {
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const preview = await resolveOrderPaymentRecoveryPreview(db, orderId, { nowSeconds });
    const receiptToken = createOrderReceiptToken();
    const receipt = await recordOrderReceipt(db, {
        orderId,
        token: receiptToken,
        source: options.source ?? "admin_payment_recovery",
        nowSeconds,
    });

    return {
        ...preview,
        receiptToken,
        tokenHash: receipt.tokenHash,
        expiresAt: receipt.expiresAt,
    };
}
