// Helpers shared by the dashboard order reads and writes. Not exported from the domain entry.
import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    orderInvoices,
    orderReturns,
    orderReturnLines,
    orderSupportRequests,
    orderTaxSnapshots,
    customers,
    deliveryShipments,
    paymentSessionAttempts,
    orderPayments,
    codTracking,
    refundAttempts,
    paymentPlans,
    webhookEvents,
    orderDiscountAllocations,
    OrderStatus,
    PaymentMethod,
    PaymentRecordStatus,
    PaymentStatus,
    ItemFulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import { isOnlinePaymentMethod, listPaymentGateways } from "../../payments/gateways/registry";
import { sql, eq, inArray, isNull, and, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
import { fromMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/utils";
import type {
    OrderListItem,
    OrderPaymentRecoverySummary,
    OrderShipmentRecoverySummary,
    OrderShipmentSummary,
} from "../types";
import { hasActiveShipmentClaim } from "../shipment-claim";
import { PROVIDER_OUTCOME_UNKNOWN } from "../../delivery/types";
import { noActiveRefundAttemptForOrderColumnCondition } from "../../payments/refund-attempt-guard";
import { PAYMENT_BLOCKED_ORDER_STATUSES } from "../../payments/payable-order";

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

export type SQLiteBatchItem = BatchItem<"sqlite">;

export const OPEN_ORDER_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);

// Drizzle renders `${orders.id}` unqualified in a single-table select, and an
// unqualified `id` inside these EXISTS subqueries binds to the subquery table's
// own id column. Qualify the outer order explicitly.
const OUTER_ORDER_ID = sql.raw('"orders"."id"');

export function orderEditEvidenceSelection() {
    const exists = (table: SQL, orderId: SQL, extra?: SQL) => sql<number>`EXISTS (
        SELECT 1 FROM ${table} WHERE ${orderId} = ${OUTER_ORDER_ID}${extra ? sql` AND ${extra}` : sql``}
    )`;
    return {
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        paidAmountMinor: orders.paidAmountMinor,
        fulfillmentStatus: orders.fulfillmentStatus,
        inventoryAction: orders.inventoryAction,
        shipmentClaimId: orders.shipmentClaimId,
        archivedAt: orders.archivedAt,
        hasTaxSnapshot: exists(sql`${orderTaxSnapshots}`, sql`${orderTaxSnapshots.orderId}`),
        hasPaymentHistory: exists(sql`${orderPayments}`, sql`${orderPayments.orderId}`),
        hasPaymentSessionHistory: exists(sql`${paymentSessionAttempts}`, sql`${paymentSessionAttempts.orderId}`),
        hasShipmentHistory: exists(sql`${deliveryShipments}`, sql`${deliveryShipments.orderId}`),
        hasRefundHistory: exists(sql`${refundAttempts}`, sql`${refundAttempts.orderId}`),
        hasReturnHistory: exists(sql`${orderReturns}`, sql`${orderReturns.orderId}`),
        hasInvoiceHistory: exists(sql`${orderInvoices}`, sql`${orderInvoices.orderId}`),
        hasPaymentPlan: exists(sql`${paymentPlans}`, sql`${paymentPlans.orderId}`),
        hasPromotionAllocation: exists(sql`${orderDiscountAllocations}`, sql`${orderDiscountAllocations.orderId}`),
        hasNonPendingItem: exists(
            sql`${orderItems}`,
            sql`${orderItems.orderId}`,
            sql`(${orderItems.fulfillmentStatus} <> ${ItemFulfillmentStatus.PENDING} OR ${orderItems.fulfilledQuantity} > 0)`,
        ),
        hasCleanCodTracking: exists(
            sql`${codTracking}`,
            sql`${codTracking.orderId}`,
            sql`${codTracking.codStatus} = 'pending'
              AND ${codTracking.collectedAt} IS NULL
              AND COALESCE(${codTracking.collectedAmountMinor}, 0) = 0`,
        ),
    };
}
export type OrderListPaymentAttemptRow = {
    orderId: string;
    gateway: string;
    paymentType: string;
    status: string;
    attempts: number;
    claimExpiresAt: number | null;
    createdAt: number;
    updatedAt: number;
};
type OrderRecoverySourceRow = {
    id: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string | null;
    paymentRecoveryApplicable?: number | boolean;
    shipmentClaimId?: string | null;
    shipmentClaimExpiresAt?: Date | number | string | null;
};

export const HOSTED_PAYMENT_METHODS = listPaymentGateways().map((gateway) => gateway.id);

const DEFAULT_PAYMENT_RECOVERY_SUMMARY: OrderPaymentRecoverySummary = {
    state: "none",
    label: "No payment recovery",
    message: null,
    gateway: null,
    paymentType: null,
    status: null,
    attempts: 0,
    activeProcessing: false,
    staleProcessing: false,
    updatedAt: null,
};

const DEFAULT_SHIPMENT_RECOVERY_SUMMARY: OrderShipmentRecoverySummary = {
    state: "none",
    reason: "none",
    severity: "info",
    activeLock: false,
    label: "No shipment recovery",
    message: null,
    shipmentId: null,
    status: null,
    providerType: null,
    canRefresh: false,
    canRetryCreate: false,
    canRepair: false,
    unknownOutcome: false,
    updatedAt: null,
};

function isHostedPaymentMethod(method: string | null | undefined): method is string {
    return isOnlinePaymentMethod(method);
}

const SETTLED_PAYMENT_STATUSES = [
    PaymentStatus.PAID,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
] as const;

export function paymentRecoveryLifecycleCondition() {
    const orderIdSql = sql`${orders.id}`;
    // Open, unsettled orders retain their existing recovery policy. Closed or
    // settled (paid/refunded) orders surface only current provider/money work,
    // never an old failed attempt the buyer already paid past.
    return sql<number>`CASE
        WHEN NOT ${inArray(orders.status, [...PAYMENT_BLOCKED_ORDER_STATUSES])}
            AND NOT ${inArray(orders.paymentStatus, [...SETTLED_PAYMENT_STATUSES])} THEN 1
        WHEN ${inArray(orders.status, [OrderStatus.CANCELLED, OrderStatus.RETURNED])}
            AND ${orders.paidAmountMinor} > 0 THEN 1
        WHEN EXISTS (
            SELECT 1 FROM ${paymentSessionAttempts}
            WHERE ${paymentSessionAttempts.orderId} = ${orderIdSql}
              AND ${paymentSessionAttempts.status} = 'processing'
        ) THEN 1
        WHEN EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderIdSql}
              AND ${inArray(orderPayments.status, [PaymentRecordStatus.PENDING, PaymentRecordStatus.CONFIRMED])}
        ) THEN 1
        WHEN NOT (${noActiveRefundAttemptForOrderColumnCondition(orderIdSql)}) THEN 1
        WHEN EXISTS (
            SELECT 1 FROM ${webhookEvents}
            WHERE ${webhookEvents.orderId} = ${orderIdSql}
              AND ${inArray(webhookEvents.provider, [...HOSTED_PAYMENT_METHODS])}
              AND ${webhookEvents.status} IN ('processing', 'queued', 'failed', 'manual_reconciliation')
        ) THEN 1
        ELSE 0
    END`;
}

export function isActivePaymentAttempt(attempt: OrderListPaymentAttemptRow, nowSeconds: number) {
    return attempt.status === "processing"
        && attempt.claimExpiresAt !== null
        && attempt.claimExpiresAt > nowSeconds;
}

export function isStalePaymentAttempt(attempt: OrderListPaymentAttemptRow, nowSeconds: number) {
    return attempt.status === "processing"
        && (attempt.claimExpiresAt === null || attempt.claimExpiresAt <= nowSeconds);
}

export function findLatestAttempt(
    attempts: OrderListPaymentAttemptRow[],
    predicate: (attempt: OrderListPaymentAttemptRow) => boolean,
) {
    return attempts
        .filter(predicate)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ?? null;
}

export function buildPaymentRecoverySummary(
    order: OrderRecoverySourceRow,
    attempts: OrderListPaymentAttemptRow[],
    nowSeconds: number,
): OrderPaymentRecoverySummary {
    const activeAttempt = findLatestAttempt(attempts, (attempt) => isActivePaymentAttempt(attempt, nowSeconds));
    if (activeAttempt) {
        return {
            state: "processing",
            label: "Payment setup running",
            message: "An online payment session is being prepared. Avoid manual recovery until it finishes.",
            gateway: activeAttempt.gateway,
            paymentType: activeAttempt.paymentType,
            status: activeAttempt.status,
            attempts: activeAttempt.attempts,
            activeProcessing: true,
            staleProcessing: false,
            updatedAt: unixToDate(activeAttempt.updatedAt),
        };
    }

    const failedAttempt = findLatestAttempt(attempts, (attempt) => attempt.status === "failed");
    const staleAttempt = findLatestAttempt(attempts, (attempt) => isStalePaymentAttempt(attempt, nowSeconds));
    const isClosed = (PAYMENT_BLOCKED_ORDER_STATUSES as readonly string[]).includes(order.status)
        || (SETTLED_PAYMENT_STATUSES as readonly string[]).includes(order.paymentStatus);
    if (isClosed && !order.paymentRecoveryApplicable && !staleAttempt) {
        return { ...DEFAULT_PAYMENT_RECOVERY_SUMMARY };
    }
    const attentionAttempt = failedAttempt ?? staleAttempt;
    if (attentionAttempt || (isHostedPaymentMethod(order.paymentMethod) && order.paymentStatus === PaymentStatus.FAILED)) {
        return {
            state: "needs_attention",
            label: failedAttempt || order.paymentStatus === PaymentStatus.FAILED
                ? "Payment needs attention"
                : "Payment setup stalled",
            message: isClosed
                ? "This order still has payment activity to reconcile. Review the payment card."
                : failedAttempt || order.paymentStatus === PaymentStatus.FAILED
                ? "The online payment flow failed. Open the order payment panel to retry or reconcile."
                : "Payment setup stopped before finishing. Open the order payment panel before taking shipment or delete actions.",
            gateway: attentionAttempt?.gateway ?? order.paymentMethod,
            paymentType: attentionAttempt?.paymentType ?? null,
            status: attentionAttempt?.status ?? order.paymentStatus,
            attempts: attentionAttempt?.attempts ?? 0,
            activeProcessing: false,
            staleProcessing: staleAttempt !== null,
            updatedAt: unixToDate(attentionAttempt?.updatedAt),
        };
    }

    if (
        isHostedPaymentMethod(order.paymentMethod)
        && order.status === OrderStatus.INCOMPLETE
        && order.paymentStatus === PaymentStatus.UNPAID
    ) {
        const latestAttempt = findLatestAttempt(attempts, () => true);
        return {
            state: "awaiting_payment",
            label: "Awaiting online payment",
            message: "The order is waiting for buyer payment or gateway confirmation.",
            gateway: latestAttempt?.gateway ?? order.paymentMethod,
            paymentType: latestAttempt?.paymentType ?? null,
            status: latestAttempt?.status ?? order.paymentStatus,
            attempts: latestAttempt?.attempts ?? 0,
            activeProcessing: false,
            staleProcessing: false,
            updatedAt: unixToDate(latestAttempt?.updatedAt),
        };
    }

    return { ...DEFAULT_PAYMENT_RECOVERY_SUMMARY };
}

export function buildShipmentRecoverySummary(
    order: OrderRecoverySourceRow,
    latestShipment: OrderShipmentSummary | null,
    nowSeconds: number,
): OrderShipmentRecoverySummary {
    const hasActiveClaim = hasActiveShipmentClaim(order, nowSeconds);
    const hasClaim = Boolean(order.shipmentClaimId);
    const status = latestShipment?.status?.toLowerCase() ?? null;
    const shipmentId = latestShipment?.id ?? null;
    const providerType = latestShipment?.providerType ?? null;
    const canProviderRefresh = Boolean(latestShipment?.providerId && latestShipment.externalId);

    if (latestShipment?.rawStatus === PROVIDER_OUTCOME_UNKNOWN) {
        return {
            state: "needs_attention",
            reason: "courier_unconfirmed",
            severity: "danger",
            activeLock: true,
            label: "Courier confirmation needed",
            message: "The courier may have accepted this shipment, but Scalius could not confirm the result. Check the courier portal or contact the courier with this order number before attempting another booking.",
            shipmentId,
            status,
            providerType,
            canRefresh: false,
            canRetryCreate: false,
            canRepair: false,
            unknownOutcome: true,
            updatedAt: latestShipment.updatedAt,
        };
    }

    if (status === ShipmentStatus.RECONCILE_REQUIRED) {
        return {
            state: "needs_attention",
            reason: "reconcile_required",
            severity: "danger",
            activeLock: true,
            label: "Shipment needs reconciliation",
            message: "A courier request may have reached the provider, but local order finalization did not settle. Open the shipment history before changing this order.",
            shipmentId,
            status,
            providerType,
            canRefresh: canProviderRefresh && !hasActiveClaim,
            canRetryCreate: false,
            canRepair: true,
            unknownOutcome: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (hasActiveClaim) {
        return {
            state: "creating",
            reason: "creating",
            severity: "warning",
            activeLock: true,
            label: "Shipment creation running",
            message: "A shipment is being created or recovered. Wait for it to finish before editing, deleting, or shipping this order again.",
            shipmentId,
            status,
            providerType,
            canRefresh: false,
            canRetryCreate: false,
            canRepair: false,
            unknownOutcome: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (hasClaim && status && ![ShipmentStatus.FAILED, ShipmentStatus.CANCELLED].includes(status as typeof ShipmentStatus.FAILED | typeof ShipmentStatus.CANCELLED)) {
        return {
            state: "needs_attention",
            reason: "claim_expired",
            severity: "danger",
            activeLock: true,
            label: "Shipment recovery required",
            message: "A previous shipment attempt expired without a clean finish. Open the order and resolve the shipment before retrying bulk actions.",
            shipmentId,
            status,
            providerType,
            canRefresh: canProviderRefresh,
            canRetryCreate: false,
            canRepair: false,
            unknownOutcome: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (status === ShipmentStatus.CREATING) {
        return {
            state: "creating",
            reason: "creating",
            severity: "warning",
            activeLock: true,
            label: "Shipment creation running",
            message: "The courier shipment row is still being created. Wait for it to settle before retrying.",
            shipmentId,
            status,
            providerType,
            canRefresh: false,
            canRetryCreate: false,
            canRepair: false,
            unknownOutcome: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    // An own rider who couldn't deliver is a delivery attempt (shown with the
    // cash-on-delivery state), not a courier booking to fix (R3-ORD-05).
    const ownRiderAttempt = status === ShipmentStatus.DELIVERY_FAILED && providerType === "manual";
    if (
        !ownRiderAttempt && (
            status === ShipmentStatus.FAILED ||
            status === ShipmentStatus.PICKUP_FAILED ||
            status === ShipmentStatus.DELIVERY_FAILED
        )
    ) {
        return {
            state: "failed",
            reason: "failed",
            severity: "warning",
            activeLock: false,
            label: "Shipment failed",
            message: "Fix the delivery provider setup or address issue, then create a new shipment.",
            shipmentId,
            status,
            providerType,
            canRefresh: canProviderRefresh,
            canRetryCreate: true,
            canRepair: false,
            unknownOutcome: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    return { ...DEFAULT_SHIPMENT_RECOVERY_SUMMARY };
}

export interface OrderListFactsRow {
    orderNumber: number | null;
    archivedAt: Date | null;
    openRequestType: string | null;
    codStatus: string | null;
    codDeliveryAttempts: number | null;
    returnedValueMinor: number;
    refundedMinor: number;
    requiresShipping: boolean;
    shippingMethodKind: "delivery" | "pickup" | null;
    pickupReadyAt: Date | null;
}

/**
 * Per-order facts the list and detail both show: the open customer request,
 * the cash-on-delivery state, and the value of received returns versus what
 * was already refunded (the "refund owed" amount, ORD-05).
 */
export function orderListFactsSelection() {
    const outerOrderId = sql`${orders.id}`;
    return {
        orderNumber: orders.orderNumber,
        archivedAt: orders.archivedAt,
        requiresShipping: orders.requiresShipping,
        shippingMethodKind: orders.shippingMethodKind,
        pickupReadyAt: orders.pickupReadyAt,
        openRequestType: sql<string | null>`(
            SELECT ${orderSupportRequests.type} FROM ${orderSupportRequests}
            WHERE ${orderSupportRequests.orderId} = ${outerOrderId}
              AND ${orderSupportRequests.activeKey} IS NOT NULL
            LIMIT 1
        )`,
        codStatus: codTracking.codStatus,
        codDeliveryAttempts: codTracking.deliveryAttempts,
        returnedValueMinor: sql<number>`COALESCE((
            SELECT SUM(
                (${orderItems.lineSubtotalMinor} - ${orderItems.discountAmountMinor}
                  + CASE WHEN ${orders.pricesIncludeTax} THEN 0 ELSE ${orderItems.taxAmountMinor} END)
                * ${orderReturnLines.receivedQuantity} / ${orderItems.quantity}
            )
            FROM ${orderReturnLines}
            INNER JOIN ${orderReturns} ON ${orderReturns.id} = ${orderReturnLines.returnId}
            INNER JOIN ${orderItems} ON ${orderItems.id} = ${orderReturnLines.orderItemId}
            WHERE ${orderReturnLines.orderId} = ${outerOrderId}
              AND ${orderReturns.status} NOT IN ('cancelled', 'rejected')
              AND ${orderItems.quantity} > 0
        ), 0)`,
        refundedMinor: sql<number>`COALESCE((
            SELECT SUM(${orderPayments.amountMinor}) FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${outerOrderId}
              AND ${orderPayments.paymentType} = 'refund'
              AND ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED}
        ), 0)`,
    };
}

export function presentOrderListFacts(order: OrderListFactsRow & {
    paymentMethod: string | null;
    paidAmountMinor: number;
    currencyDecimalPlaces: number;
}) {
    const refundedMinor = Number(order.refundedMinor) || 0;
    const capturedMinor = order.paidAmountMinor + refundedMinor;
    const refundDueMinor = Math.max(
        0,
        Math.min(Number(order.returnedValueMinor) || 0, capturedMinor) - refundedMinor,
    );
    return {
        orderNumber: order.orderNumber,
        archivedAt: unixToDate(order.archivedAt),
        openRequestType: order.openRequestType as OrderListItem["openRequestType"],
        cod: order.paymentMethod === PaymentMethod.COD && order.codStatus
            ? { status: order.codStatus, deliveryAttempts: order.codDeliveryAttempts ?? 0 }
            : null,
        refundDue: fromMinor(refundDueMinor, order.currencyDecimalPlaces),
        refundedAmount: fromMinor(refundedMinor, order.currencyDecimalPlaces),
        requiresShipping: order.requiresShipping !== false,
        shippingMethodKind: order.shippingMethodKind ?? null,
        pickupReadyAt: order.pickupReadyAt ?? null,
    };
}

export async function updateCustomerStatsService(db: Database, customerId: string) {
    const customerOrders = await db.select({ createdAt: orders.createdAt })
        .from(orders).where(and(
            eq(orders.customerId, customerId),
            isNull(orders.deletedAt),
        ));
    const stats = calculateCustomerStats(customerOrders);
    await db.update(customers).set({
        totalOrders: stats.totalOrders,
        lastOrderAt: stats.lastOrderAt ? sql`${Math.floor(stats.lastOrderAt.getTime() / 1000)}` : null,
        updatedAt: sql`unixepoch()`,
    }).where(eq(customers.id, customerId));
}
