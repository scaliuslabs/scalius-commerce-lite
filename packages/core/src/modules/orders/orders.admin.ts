// src/modules/orders/orders.admin.ts
// Admin order service: queries and CRUD mutations.

import { safeBatch, type Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    orderInvoices,
    customers,
    customerHistory,
    products,
    productVariants,
    media,
    deliveryShipments,
    deliveryProviders,
    paymentSessionAttempts,
    orderPayments,
    paymentPlans,
    OrderStatus,
    PaymentMethod,
    PaymentPlanStatus,
    PaymentRecordStatus,
    PaymentStatus,
    ItemFulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import {
    applyClaimedInventoryEntryBatch,
    applyInventoryForStatusChange,
    isStockDeductStatus,
    isStockReservableStatus,
    isStockRestoreStatus,
} from "../inventory/inventory-transitions";
import {
    reserveStockBatch,
    releaseReservedStockBatch,
    validateStockBatchAvailability,
} from "../inventory";
import type { ReservationEntry } from "../inventory";

import { sql, desc, eq, inArray, isNotNull, isNull, and, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ftsMatch, sanitizeFtsQuery } from "../../search/fts5";
import { generateOrderId } from "@scalius/shared/order-utils";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
import { normalizeOrderStatus } from "@scalius/shared/order-state";
import { unixToDate } from "@scalius/shared/utils";
import { nanoid } from "nanoid";
import type { CreateOrderInput } from "./orders.validation";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { validateTransition } from "./order-state-machine";
import type {
    OrderDetails,
    OrderPaymentRecoveryFilter,
    OrderPaymentRecoverySummary,
    OrderShipmentRecoverySummary,
    OrderShipmentSummary,
} from "./orders.types";
import { buildPhoneSearchTerms, isLikelyPhoneSearch } from "./orders.search";
import { assertNoActiveShipmentClaim, hasActiveShipmentClaim } from "./shipment-claim";
import { computeOrderPaymentState } from "../payments/payment-state";
import {
    createOrderCurrencySnapshot,
    resolveOrderCurrencySnapshot,
    roundOrderMoney,
    type OrderCurrencySnapshot,
} from "../payments/order-currency";
import { getCurrencySettings } from "../settings/site-settings.service";
import { toMinorUnits } from "../tax";
import {
    assertNoActiveRefundAttempt,
    assertNoActiveRefundAttemptsForOrders,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    listActiveRefundOperationsForOrders,
    listOrderRefundAttempts,
    summarizeActiveRefundOperation,
} from "../payments/refund-attempt-visibility";
import { variantOptionLabelSql } from "../products/products.option-model";
import {
    loadProductMediaProjections,
    resolveSkuImageRepresentation,
} from "../products/products.media";
import {
    activePaymentSessionAttemptExistsCondition,
    assertNoActivePaymentSessionAttempt,
    assertNoActivePaymentSessionAttemptsForOrders,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";
import { resolveActiveDeliveryLocationNames } from "./delivery-location-validation";
import { listOrderSupportRequests } from "./order-support-requests";
import { createOrderReceiptToken, recordOrderReceipt } from "./order-receipts";
import {
    assertNoActiveReturnReceipt,
    assertOrderItemsHaveNoReturnHistory,
} from "./order-returns";
import { assertGenericAdminOrderStatusTransition } from "./admin-status-policy";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

const TRASH_RESTORE_DEDUCTED_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.COMPLETED,
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
]);
type SQLiteBatchItem = BatchItem<"sqlite">;
const ADMIN_CREATE_ROLLBACK_RELEASE_KEY = "admin-order-create-rollback:v1";
const MAX_ORDER_LIST_LIMIT = 100;

async function assertOrderHasNoIssuedInvoice(db: Database, orderId: string): Promise<void> {
    const invoice = await db
        .select({ id: orderInvoices.id })
        .from(orderInvoices)
        .where(eq(orderInvoices.orderId, orderId))
        .get();
    if (invoice) {
        throw new ConflictError(
            "Issued invoice facts are immutable. Create an amendment or replacement order instead.",
        );
    }
}
type OrderListSort = "relevance" | "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
type OrderListPaymentAttemptRow = {
    orderId: string;
    gateway: string;
    paymentType: string;
    amount?: number;
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
    shipmentClaimId?: string | null;
    shipmentClaimExpiresAt?: Date | number | string | null;
};
type AdminOrderSkuItem = { productId: string; variantId: string | null };
type AdminOrderItemWithInventory<T extends AdminOrderSkuItem> = T & {
    variantId: string;
    inventoryTracked: boolean;
    productName: string;
    variantLabel: string | null;
    productImageMediaId: string | null;
};
type AdminOrderSkuIssueCode =
    | "SKU_REQUIRED"
    | "VARIANT_UNAVAILABLE"
    | "VARIANT_MISMATCH"
    | "PRODUCT_UNAVAILABLE";

interface ManualOrderMoneyItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
}

function calculateManualOrderMoney(
    items: ManualOrderMoneyItem[],
    shippingCharge: number,
    discountAmount: number | null,
    currency: OrderCurrencySnapshot,
) {
    const normalizedItems = items.map((item) => ({
        ...item,
        price: roundOrderMoney(item.price, currency),
    }));
    const subtotal = normalizedItems.reduce(
        (sum, item) => roundOrderMoney(
            sum + roundOrderMoney(item.price * item.quantity, currency),
            currency,
        ),
        0,
    );
    const normalizedShipping = roundOrderMoney(shippingCharge, currency);
    const normalizedDiscount = roundOrderMoney(discountAmount ?? 0, currency);
    const grossAmount = roundOrderMoney(subtotal + normalizedShipping, currency);
    if (normalizedDiscount > grossAmount) {
        throw new ValidationError("Discount amount cannot exceed the manual order subtotal and shipping.");
    }
    const totalAmount = roundOrderMoney(grossAmount - normalizedDiscount, currency);

    return {
        normalizedItems,
        subtotal,
        shippingCharge: normalizedShipping,
        discountAmount: normalizedDiscount,
        totalAmount,
        subtotalAmountMinor: toMinorUnits(subtotal, currency.decimalPlaces),
        shippingAmountMinor: toMinorUnits(normalizedShipping, currency.decimalPlaces),
        discountAmountMinor: toMinorUnits(normalizedDiscount, currency.decimalPlaces),
        totalAmountMinor: toMinorUnits(totalAmount, currency.decimalPlaces),
    };
}
export type BuyerRecoveryPaymentMethod =
    | typeof PaymentMethod.SSLCOMMERZ
    | typeof PaymentMethod.POLAR;
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

interface AdminOrderSkuIssue {
    index: number;
    productId: string;
    variantId: string | null;
    code: AdminOrderSkuIssueCode;
    message: string;
}

const HOSTED_PAYMENT_METHODS = [
    PaymentMethod.STRIPE,
    PaymentMethod.SSLCOMMERZ,
    PaymentMethod.POLAR,
] as const;

const BUYER_RECOVERY_PAYMENT_METHODS = [
    PaymentMethod.SSLCOMMERZ,
    PaymentMethod.POLAR,
] as const;

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
    severity: "info",
    activeLock: false,
    label: "No shipment recovery",
    message: null,
    shipmentId: null,
    status: null,
    providerType: null,
    canRefresh: false,
    canRetryCreate: false,
    updatedAt: null,
};

function throwAdminOrderSkuIssues(issues: AdminOrderSkuIssue[]): never {
    throw new ValidationError("Some manual order items need attention.", { itemIssues: issues });
}

function addAdminOrderSkuIssue(
    issues: AdminOrderSkuIssue[],
    item: AdminOrderSkuItem,
    index: number,
    code: AdminOrderSkuIssueCode,
    message: string,
) {
    issues.push({
        index,
        productId: item.productId,
        variantId: item.variantId ?? null,
        code,
        message,
    });
}

function isHostedPaymentMethod(method: string | null | undefined): method is (typeof HOSTED_PAYMENT_METHODS)[number] {
    return typeof method === "string" && (HOSTED_PAYMENT_METHODS as readonly string[]).includes(method);
}

function isBuyerRecoveryPaymentMethod(method: string | null | undefined): method is BuyerRecoveryPaymentMethod {
    return typeof method === "string" && (BUYER_RECOVERY_PAYMENT_METHODS as readonly string[]).includes(method);
}

function isRecoveryLinkPaymentType(value: string | null | undefined): value is RecoveryLinkPaymentType {
    return value === "full" || value === "deposit" || value === "balance";
}

function staleOrFailedPaymentSessionAttemptExistsCondition(orderIdSql: SQL) {
    return sql`EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.orderId} = ${orderIdSql}
          AND (
            ${paymentSessionAttempts.status} = 'failed'
            OR (
              ${paymentSessionAttempts.status} = 'processing'
              AND (
                ${paymentSessionAttempts.claimExpiresAt} IS NULL
                OR ${paymentSessionAttempts.claimExpiresAt} <= unixepoch()
              )
            )
          )
    )`;
}

function paymentRecoveryFilterCondition(filter: OrderPaymentRecoveryFilter) {
    const orderIdSql = sql`${orders.id}`;
    const activeAttempt = activePaymentSessionAttemptExistsCondition(orderIdSql);
    const staleOrFailedAttempt = staleOrFailedPaymentSessionAttemptExistsCondition(orderIdSql);
    const hostedMethod = inArray(orders.paymentMethod, [...HOSTED_PAYMENT_METHODS]);
    const needsAttention = sql`(
        ${hostedMethod}
        AND (
          ${orders.paymentStatus} = ${PaymentStatus.FAILED}
          OR ${staleOrFailedAttempt}
        )
    )`;
    const awaitingPayment = sql`(
        ${hostedMethod}
        AND ${orders.status} = ${OrderStatus.INCOMPLETE}
        AND ${orders.paymentStatus} = ${PaymentStatus.UNPAID}
        AND NOT ${activeAttempt}
        AND NOT ${staleOrFailedAttempt}
    )`;

    switch (filter) {
        case "processing":
            return activeAttempt;
        case "needs_attention":
            return needsAttention;
        case "awaiting_payment":
            return awaitingPayment;
        case "recoverable":
            return sql`(${activeAttempt} OR ${needsAttention} OR ${awaitingPayment})`;
    }
}

function isActivePaymentAttempt(attempt: OrderListPaymentAttemptRow, nowSeconds: number) {
    return attempt.status === "processing"
        && attempt.claimExpiresAt !== null
        && attempt.claimExpiresAt > nowSeconds;
}

function isStalePaymentAttempt(attempt: OrderListPaymentAttemptRow, nowSeconds: number) {
    return attempt.status === "processing"
        && (attempt.claimExpiresAt === null || attempt.claimExpiresAt <= nowSeconds);
}

function findLatestAttempt(
    attempts: OrderListPaymentAttemptRow[],
    predicate: (attempt: OrderListPaymentAttemptRow) => boolean,
) {
    return attempts
        .filter(predicate)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] ?? null;
}

function buildPaymentRecoverySummary(
    order: OrderRecoverySourceRow,
    attempts: OrderListPaymentAttemptRow[],
    nowSeconds: number,
): OrderPaymentRecoverySummary {
    const activeAttempt = findLatestAttempt(attempts, (attempt) => isActivePaymentAttempt(attempt, nowSeconds));
    if (activeAttempt) {
        return {
            state: "processing",
            label: "Payment setup running",
            message: "A hosted payment session is being prepared. Avoid manual recovery until it finishes.",
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
    const attentionAttempt = failedAttempt ?? staleAttempt;
    if (attentionAttempt || (isHostedPaymentMethod(order.paymentMethod) && order.paymentStatus === PaymentStatus.FAILED)) {
        return {
            state: "needs_attention",
            label: failedAttempt || order.paymentStatus === PaymentStatus.FAILED
                ? "Payment needs attention"
                : "Payment setup stalled",
            message: failedAttempt || order.paymentStatus === PaymentStatus.FAILED
                ? "The hosted payment flow failed. Open the order payment panel to retry or reconcile."
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
            label: "Awaiting hosted payment",
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

function buildShipmentRecoverySummary(
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

    if (status === ShipmentStatus.RECONCILE_REQUIRED) {
        return {
            state: "needs_attention",
            severity: "danger",
            activeLock: true,
            label: "Shipment needs reconciliation",
            message: "A courier request may have reached the provider, but local order finalization did not settle. Open the shipment history before changing this order.",
            shipmentId,
            status,
            providerType,
            canRefresh: canProviderRefresh && !hasActiveClaim,
            canRetryCreate: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (hasActiveClaim) {
        return {
            state: "creating",
            severity: "warning",
            activeLock: true,
            label: "Shipment creation running",
            message: "A shipment is being created or recovered. Wait for it to finish before editing, deleting, or shipping this order again.",
            shipmentId,
            status,
            providerType,
            canRefresh: false,
            canRetryCreate: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (hasClaim && status && ![ShipmentStatus.FAILED, ShipmentStatus.CANCELLED].includes(status as typeof ShipmentStatus.FAILED | typeof ShipmentStatus.CANCELLED)) {
        return {
            state: "needs_attention",
            severity: "danger",
            activeLock: true,
            label: "Shipment recovery required",
            message: "A previous shipment attempt expired without a clean finish. Open the order and resolve the shipment before retrying bulk actions.",
            shipmentId,
            status,
            providerType,
            canRefresh: canProviderRefresh,
            canRetryCreate: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (status === ShipmentStatus.CREATING) {
        return {
            state: "creating",
            severity: "warning",
            activeLock: true,
            label: "Shipment creation running",
            message: "The courier shipment row is still being created. Wait for it to settle before retrying.",
            shipmentId,
            status,
            providerType,
            canRefresh: false,
            canRetryCreate: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    if (
        status === ShipmentStatus.FAILED ||
        status === ShipmentStatus.PICKUP_FAILED ||
        status === ShipmentStatus.DELIVERY_FAILED
    ) {
        return {
            state: "failed",
            severity: "warning",
            activeLock: false,
            label: "Shipment failed",
            message: "Fix the delivery provider setup or address issue, then create a new shipment.",
            shipmentId,
            status,
            providerType,
            canRefresh: canProviderRefresh,
            canRetryCreate: true,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    return { ...DEFAULT_SHIPMENT_RECOVERY_SUMMARY };
}

function orderEditReadyCondition(orderId: string, expectedVersion: number) {
    return sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId}
          AND ${orders.version} = ${expectedVersion}
          AND ${orders.deletedAt} IS NULL
          AND ${noActiveRefundAttemptForOrderIdCondition(orderId)}
          AND ${noActivePaymentSessionAttemptForOrderIdCondition(orderId)}
    )`;
}

function orderEditCommittedCondition(orderId: string, committedVersion: number) {
    return sql`changes() = 1
        AND EXISTS (
            SELECT 1 FROM ${orders}
            WHERE ${orders.id} = ${orderId}
              AND ${orders.version} = ${committedVersion}
              AND ${orders.deletedAt} IS NULL
        )`;
}

function buildGuardedCustomerInsert(
    db: Database,
    orderId: string,
    customerId: string,
    data: UpdateOrderData,
    totalAmount: number,
    expectedOrderVersion: number,
): SQLiteBatchItem {
    return db.insert(customers).select(sql`
        SELECT
            ${customerId},
            ${data.customerName},
            ${data.customerEmail},
            ${data.customerPhone},
            ${data.shippingAddress},
            ${data.city},
            ${data.zone},
            ${data.area},
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            1,
            ${totalAmount},
            unixepoch(),
            unixepoch(),
            unixepoch(),
            NULL
        WHERE ${orderEditReadyCondition(orderId, expectedOrderVersion)}
    `);
}

function buildGuardedOrderItemInsert(
    db: Database,
    orderId: string,
    committedOrderVersion: number,
    item: AdminOrderItemWithInventory<UpdateOrderData["items"][number]>,
): SQLiteBatchItem {
    const itemId = "item_" + nanoid();
    return db.insert(orderItems).select(sql`
        SELECT
            ${itemId},
            ${orderId},
            ${item.productId},
            ${item.variantId},
            ${item.productImageMediaId},
            ${item.quantity},
            ${item.price},
            ${item.productName},
            ${item.variantLabel},
            ${item.inventoryTracked ? 1 : 0},
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            ${ItemFulfillmentStatus.PENDING},
            unixepoch()
        WHERE ${orderEditCommittedCondition(orderId, committedOrderVersion)}
    `);
}

function buildGuardedOrderItemsDelete(
    db: Database,
    orderId: string,
    committedOrderVersion: number,
    existingItems: Array<{ id: string }>,
): SQLiteBatchItem | null {
    const itemIds = existingItems.map((item) => item.id).filter(Boolean);
    if (itemIds.length === 0) return null;

    return db.delete(orderItems).where(and(
        eq(orderItems.orderId, orderId),
        inArray(orderItems.id, itemIds),
        orderEditCommittedCondition(orderId, committedOrderVersion),
    ));
}

function assertAdminOrderItemsUseSkus(items: AdminOrderSkuItem[]) {
    const issues: AdminOrderSkuIssue[] = [];
    items.forEach((item, index) => {
        if (!item.variantId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "SKU_REQUIRED",
                "Select a product SKU before saving the order.",
            );
        }
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }
}

export async function resolveAdminOrderItemInventory<T extends AdminOrderSkuItem>(
    db: Database,
    items: T[],
): Promise<Array<AdminOrderItemWithInventory<T>>> {
    assertAdminOrderItemsUseSkus(items);

    const variantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id)))];
    if (variantIds.length === 0) return [];

    const rows = await db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            trackInventory: productVariants.trackInventory,
            imageId: productVariants.imageId,
            productName: products.name,
            variantLabel: variantOptionLabelSql(productVariants.id),
            variantDeletedAt: productVariants.deletedAt,
            productActive: products.isActive,
            productDeletedAt: products.deletedAt,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(productVariants.id, variantIds));

    const skuByVariantId = new Map(rows.map((row) => [row.id, row]));
    const mediaByProduct = await loadProductMediaProjections(
        db,
        [...new Set(rows.map((row) => row.productId))],
    );
    const issues: AdminOrderSkuIssue[] = [];
    const resolvedItems: Array<AdminOrderItemWithInventory<T>> = [];

    items.forEach((item, index) => {
        const variantId = item.variantId!;
        const sku = skuByVariantId.get(variantId);
        if (!sku) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU is no longer available.",
            );
            return;
        }
        if (sku.productId !== item.productId) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_MISMATCH",
                "Selected SKU does not belong to this product.",
            );
            return;
        }
        if (sku.variantDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "VARIANT_UNAVAILABLE",
                "Selected SKU has been deleted.",
            );
            return;
        }
        if (!sku.productActive || sku.productDeletedAt) {
            addAdminOrderSkuIssue(
                issues,
                item,
                index,
                "PRODUCT_UNAVAILABLE",
                "Selected product is not active.",
            );
            return;
        }

        resolvedItems.push({
            ...item,
            variantId,
            inventoryTracked: sku.trackInventory,
            productName: sku.productName,
            variantLabel: sku.variantLabel,
            productImageMediaId: resolveSkuImageRepresentation(
                mediaByProduct.get(sku.productId) ?? [],
                sku.imageId,
            )?.mediaId ?? null,
        });
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }

    return resolvedItems;
}

function normalizeListPositiveInteger(value: number | undefined, fallback: number, max?: number): number {
    if (!Number.isFinite(value)) return fallback;
    const integer = Math.trunc(value as number);
    const minBounded = Math.max(1, integer);
    return max == null ? minBounded : Math.min(minBounded, max);
}

function assertTrashRestoreInventoryActionAllowed(status: string, inventoryAction: string): void {
    if (inventoryAction === "reserved" && isStockReservableStatus(status)) return;
    if (inventoryAction === "deducted" && TRASH_RESTORE_DEDUCTED_STATUSES.has(status)) return;
    if (inventoryAction === "restored" && isStockRestoreStatus(status)) return;
    if (inventoryAction === "none") return;

    throw new ValidationError(
        `Cannot restore order with status "${status}" and inventory action "${inventoryAction}". Reconcile inventory or move the order to a compatible status first.`,
    );
}

function buildPhoneSearchCondition(searchTerms: string[]): SQL | undefined {
    if (searchTerms.length === 0) return undefined;

    const normalizedCustomerPhone = sql<string>`
        replace(
            replace(
                replace(
                    replace(
                        replace(
                            replace(${orders.customerPhone}, '+', ''),
                        ' ', ''),
                    '-', ''),
                '(', ''),
            ')', ''),
        '.', '')
    `;

    return sql`(${sql.join(
        searchTerms.map((term) => sql`${normalizedCustomerPhone} LIKE ${`%${term}%`}`),
        sql` OR `,
    )})`;
}

/**
 * Returns a paginated, searchable list of orders for the admin dashboard.
 * Includes item counts and the latest shipment per order.
 */
export async function listOrders(db: Database, options: {
    search?: string;
    status?: string;
    paymentStatus?: string;
    paymentMethod?: string;
    fulfillmentStatus?: string;
    paymentRecovery?: OrderPaymentRecoveryFilter;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?: OrderListSort;
    order?: "asc" | "desc";
    startDate?: Date;
    endDate?: Date;
}) {
    const {
        search,
        status,
        paymentStatus,
        paymentMethod,
        fulfillmentStatus,
        paymentRecovery,
        page: rawPage = 1,
        limit: rawLimit = 10,
        showTrashed = false,
        sort = "updatedAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const page = normalizeListPositiveInteger(rawPage, 1);
    const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT);
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [];

    if (showTrashed) {
        whereConditions.push(sql`${orders.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${orders.deletedAt} IS NULL`);
    }

    let rankExpression: SQL | undefined = undefined;
    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
        const phoneSearchTerms = buildPhoneSearchTerms(trimmedSearch);
        const phoneCondition = buildPhoneSearchCondition(phoneSearchTerms);
        const ftsCondition = ftsMatch("orders_fts", "orders", trimmedSearch);

        if (isLikelyPhoneSearch(trimmedSearch) && phoneCondition) {
            whereConditions.push(ftsCondition ? sql`(${ftsCondition} OR ${phoneCondition})` : phoneCondition);
            const sanitized = sanitizeFtsQuery(trimmedSearch);
            rankExpression = sql`
                COALESCE(
                    (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}),
                    999999
                ) ASC
            `;
        } else if (ftsCondition) {
            whereConditions.push(ftsCondition);
            const sanitized = sanitizeFtsQuery(trimmedSearch);
            rankExpression = sql`
                COALESCE(
                    (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}),
                    999999
                ) ASC
            `;
        }
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (paymentStatus) {
        whereConditions.push(sql`${orders.paymentStatus} = ${paymentStatus}`);
    }

    if (paymentMethod) {
        whereConditions.push(sql`${orders.paymentMethod} = ${paymentMethod}`);
    }

    if (fulfillmentStatus) {
        whereConditions.push(sql`${orders.fulfillmentStatus} = ${fulfillmentStatus}`);
    }

    if (paymentRecovery) {
        whereConditions.push(paymentRecoveryFilterCondition(paymentRecovery));
    }

    if (startDate) {
        const startTs = Math.floor(startDate.getTime() / 1000);
        whereConditions.push(sql`${orders.createdAt} >= ${startTs}`);
    }

    if (endDate) {
        const endTs = Math.floor(endDate.getTime() / 1000);
        whereConditions.push(sql`${orders.createdAt} <= ${endTs}`);
    }

    const whereClause = whereConditions.length > 0
        ? sql`${sql.join(whereConditions, sql` AND `)}`
        : undefined;

    const countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(orders)
        .where(whereClause);

    const orderByExpressions = (() => {
        if (rankExpression && sort === "relevance") {
            return [
                rankExpression,
                sql`${orders.updatedAt} desc`,
                sql`${orders.id} desc`,
            ];
        }

        const sortField = (() => {
            switch (sort) {
                case "customerName":
                    return orders.customerName;
                case "totalAmount":
                    return orders.totalAmount;
                case "status":
                    return orders.status;
                case "createdAt":
                    return orders.createdAt;
                case "relevance":
                case "updatedAt":
                default:
                    return orders.updatedAt;
            }
        })();

        return [
            order === "asc" ? sql`${sortField} asc` : sql`${sortField} desc`,
            order === "asc" ? sql`${orders.id} asc` : sql`${orders.id} desc`,
        ];
    })();

    const dataQuery = db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            customerId: orders.customerId,
            totalAmount: orders.totalAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingAmountMinor: orders.shippingAmountMinor,
            discountAmountMinor: orders.discountAmountMinor,
            taxAmountMinor: orders.taxAmountMinor,
            totalAmountMinor: orders.totalAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(...orderByExpressions);

    // Batch count + data in a single round-trip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const batchResult = await db.batch([countQuery, dataQuery] as any) as any;
    const countArr = batchResult[0] as { count: number }[];
    const results = batchResult[1] as {
        id: string; customerName: string; customerPhone: string; customerEmail: string | null;
        customerId: string | null; totalAmount: number; shippingCharge: number; discountAmount: number;
        status: string; paymentStatus: string; paymentMethod: string | null; fulfillmentStatus: string;
        createdAt: number; updatedAt: number;
        city: string | null; zone: string | null; area: string | null;
        cityName: string | null; zoneName: string | null; areaName: string | null;
        shipmentClaimId: string | null; shipmentClaimExpiresAt: Date | number | string | null;
    }[];
    const count = countArr[0]?.count ?? 0;

    const orderIds = results.map((r) => r.id);

    const [itemCounts, shipments, paymentAttempts] = await db.batch([
        results.length > 0
            ? db
                .select({
                    orderId: orderItems.orderId,
                    count: sql<number>`COUNT(*)`,
                    totalQuantity: sql<number>`SUM(${orderItems.quantity})`,
                })
                .from(orderItems)
                .where(inArray(orderItems.orderId, orderIds))
                .groupBy(orderItems.orderId)
            : db.select({
                orderId: sql<string>`NULL`.as("orderId"),
                count: sql<number>`0`.as("count"),
                totalQuantity: sql<number>`0`.as("totalQuantity"),
            }).from(orderItems).where(sql`1=0`),
        results.length > 0
            ? db
                .select({
                    orderId: deliveryShipments.orderId,
                    id: deliveryShipments.id,
                    providerId: deliveryShipments.providerId,
                    providerType: deliveryShipments.providerType,
                    status: deliveryShipments.status,
                    rawStatus: deliveryShipments.rawStatus,
                    externalId: deliveryShipments.externalId,
                    trackingId: deliveryShipments.trackingId,
                    lastChecked: deliveryShipments.lastChecked,
                    updatedAt: deliveryShipments.updatedAt,
                    createdAt: deliveryShipments.createdAt,
                    providerName: deliveryProviders.name,
                })
                .from(deliveryShipments)
                .leftJoin(
                    deliveryProviders,
                    eq(deliveryShipments.providerId, deliveryProviders.id),
                )
                .where(inArray(deliveryShipments.orderId, orderIds))
                .orderBy(desc(deliveryShipments.createdAt))
            : db.select({
                orderId: sql<string>`NULL`.as("orderId"),
                id: sql<string>`NULL`.as("id"),
                providerId: sql<string | null>`NULL`.as("providerId"),
                providerType: sql<string | null>`NULL`.as("providerType"),
                status: sql<string>`NULL`.as("status"),
                rawStatus: sql<string | null>`NULL`.as("rawStatus"),
                externalId: sql<string | null>`NULL`.as("externalId"),
                trackingId: sql<string | null>`NULL`.as("trackingId"),
                lastChecked: sql<Date | null>`NULL`.as("lastChecked"),
                updatedAt: sql<Date | null>`NULL`.as("updatedAt"),
                createdAt: sql<Date | null>`NULL`.as("createdAt"),
                providerName: sql<string | null>`NULL`.as("providerName"),
            }).from(deliveryShipments).where(sql`1=0`),
        results.length > 0
            ? db
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
                .where(inArray(paymentSessionAttempts.orderId, orderIds))
                .orderBy(desc(paymentSessionAttempts.updatedAt), desc(paymentSessionAttempts.createdAt))
            : db.select({
                orderId: sql<string>`NULL`.as("orderId"),
                gateway: sql<string>`NULL`.as("gateway"),
                paymentType: sql<string>`NULL`.as("paymentType"),
                status: sql<string>`NULL`.as("status"),
                attempts: sql<number>`0`.as("attempts"),
                claimExpiresAt: sql<number | null>`NULL`.as("claimExpiresAt"),
                createdAt: sql<number>`0`.as("createdAt"),
                updatedAt: sql<number>`0`.as("updatedAt"),
            }).from(paymentSessionAttempts).where(sql`1=0`)
    ]);
    const activeRefundOperations = await listActiveRefundOperationsForOrders(db, orderIds);

    const itemCountMap = new Map(
        itemCounts.map((ic) => [
            ic.orderId,
            { count: ic.count, quantity: ic.totalQuantity },
        ]),
    );

    const shipmentMap = new Map<string, OrderShipmentSummary>();

    for (const shipment of shipments) {
        if (!shipmentMap.has(shipment.orderId)) {
            shipmentMap.set(shipment.orderId, {
                id: shipment.id,
                providerId: shipment.providerId,
                providerType: shipment.providerType,
                providerName: shipment.providerName,
                status: shipment.status,
                rawStatus: shipment.rawStatus,
                externalId: shipment.externalId,
                trackingId: shipment.trackingId,
                lastChecked: unixToDate(shipment.lastChecked),
                updatedAt: unixToDate(shipment.updatedAt) ?? new Date(),
                createdAt: unixToDate(shipment.createdAt) ?? new Date(),
            });
        }
    }

    const attemptsByOrderId = new Map<string, OrderListPaymentAttemptRow[]>();
    for (const attempt of paymentAttempts as OrderListPaymentAttemptRow[]) {
        if (!attempt.orderId) continue;
        const attempts = attemptsByOrderId.get(attempt.orderId) ?? [];
        attempts.push(attempt);
        attemptsByOrderId.set(attempt.orderId, attempts);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);

    const formattedResults = results.map((order) => {
        const latestShipment = shipmentMap.get(order.id) || null;
        return {
            ...order,
            createdAt: new Date(order.createdAt * 1000),
            updatedAt: new Date(order.updatedAt * 1000),
            itemCount: itemCountMap.get(order.id)?.count || 0,
            totalQuantity: itemCountMap.get(order.id)?.quantity || 0,
            latestShipment,
            shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds),
            paymentRecovery: buildPaymentRecoverySummary(
                order,
                attemptsByOrderId.get(order.id) ?? [],
                nowSeconds,
            ),
            activeRefundOperation: activeRefundOperations.get(order.id) ?? null,
        };
    });

    return {
        orders: formattedResults,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
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
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
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
    if (Number(order.paidAmount ?? 0) > 0) {
        throw new ValidationError("Order already has payment recorded and cannot receive a receipt recovery link.");
    }

    const [paymentAttempts, paymentRows, paymentPlan] = await Promise.all([
        db
            .select({
                orderId: paymentSessionAttempts.orderId,
                gateway: paymentSessionAttempts.gateway,
                paymentType: paymentSessionAttempts.paymentType,
                amount: paymentSessionAttempts.amount,
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
                depositAmount: paymentPlans.depositAmount,
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
        Number.isFinite(Number(paymentPlan.depositAmount)) &&
        Number(paymentPlan.depositAmount) > 0
        ? Number(paymentPlan.depositAmount)
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
 * Issues a fresh private receipt proof for an unpaid SSLCommerz/Polar order
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

/**
 * Returns full order details including all items and variant info.
 * Returns null if the order does not exist.
 */
export async function getOrderDetails(
    db: Database,
    id: string,
): Promise<OrderDetails | null> {
    const order = await db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            customerId: orders.customerId,
            totalAmount: orders.totalAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingAmountMinor: orders.shippingAmountMinor,
            discountAmountMinor: orders.discountAmountMinor,
            taxAmountMinor: orders.taxAmountMinor,
            totalAmountMinor: orders.totalAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            notes: orders.notes,
            shippingAddress: orders.shippingAddress,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
            version: orders.version,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${orders.deletedAt} AS INTEGER)`,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            itemCount: sql<number>`(
        SELECT COUNT(*)
        FROM ${orderItems}
        WHERE ${orderItems.orderId} = ${orders.id}
      )`,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) return null;

    const [items, latestShipments, refundAttemptViews, supportRequests] = await Promise.all([
        db
            .select({
                id: orderItems.id,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                price: orderItems.price,
                productName: orderItems.productName,
                productImageObjectKey: media.objectKey,
                productImageStatus: media.status,
                variantLabel: orderItems.variantLabel,
                fulfillmentStatus: orderItems.fulfillmentStatus,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
                discountAmountMinor: orderItems.discountAmountMinor,
                taxableAmountMinor: orderItems.taxableAmountMinor,
                taxAmountMinor: orderItems.taxAmountMinor,
            })
            .from(orderItems)
            .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
            .where(eq(orderItems.orderId, id)),
        db
            .select({
                orderId: deliveryShipments.orderId,
                id: deliveryShipments.id,
                providerId: deliveryShipments.providerId,
                providerType: deliveryShipments.providerType,
                status: deliveryShipments.status,
                rawStatus: deliveryShipments.rawStatus,
                externalId: deliveryShipments.externalId,
                trackingId: deliveryShipments.trackingId,
                lastChecked: deliveryShipments.lastChecked,
                updatedAt: deliveryShipments.updatedAt,
                createdAt: deliveryShipments.createdAt,
                providerName: deliveryProviders.name,
            })
            .from(deliveryShipments)
            .leftJoin(
                deliveryProviders,
                eq(deliveryShipments.providerId, deliveryProviders.id),
            )
            .where(eq(deliveryShipments.orderId, id))
            .orderBy(desc(deliveryShipments.createdAt))
            .limit(1),
        listOrderRefundAttempts(db, id, { audience: "admin" }),
        listOrderSupportRequests(db, id),
    ]);

    const formattedItems = items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: item.price,
        productName: item.productName || null,
        productImage:
            item.productImageObjectKey &&
            (item.productImageStatus === "ready" || item.productImageStatus === "trashed")
                ? getCurrentPublicMediaUrl(item.productImageObjectKey)
                : null,
        variantLabel: item.variantLabel || null,
        fulfillmentStatus: item.fulfillmentStatus,
        unitPriceMinor: item.unitPriceMinor,
        lineSubtotalMinor: item.lineSubtotalMinor,
        discountAmountMinor: item.discountAmountMinor,
        taxableAmountMinor: item.taxableAmountMinor,
        taxAmountMinor: item.taxAmountMinor,
    }));

    const latestShipmentRow = latestShipments[0] ?? null;
    const latestShipment: OrderShipmentSummary | null = latestShipmentRow
        ? {
            id: latestShipmentRow.id,
            providerId: latestShipmentRow.providerId,
            providerType: latestShipmentRow.providerType,
            providerName: latestShipmentRow.providerName,
            status: latestShipmentRow.status,
            rawStatus: latestShipmentRow.rawStatus,
            externalId: latestShipmentRow.externalId,
            trackingId: latestShipmentRow.trackingId,
            lastChecked: unixToDate(latestShipmentRow.lastChecked),
            updatedAt: unixToDate(latestShipmentRow.updatedAt) ?? new Date(),
            createdAt: unixToDate(latestShipmentRow.createdAt) ?? new Date(),
        }
        : null;
    const nowSeconds = Math.floor(Date.now() / 1000);

    return {
        ...order,
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        items: formattedItems,
        latestShipment,
        shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds),
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        supportRequests,
        paymentRecovery: buildPaymentRecoverySummary(order, [], nowSeconds),
    };
}

// ─────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────

/**
 * Creates an order in the admin context (manual order entry).
 * Handles customer lookup/creation, location name resolution,
 * order row insertion, and order items insertion.
 *
 * Inventory flow:
 *   1. Reserve stock for all variant items (validates availability)
 *   2. Insert order + items atomically via db.batch()
 *   3. Convert reservations to permanent deductions (admin orders are immediately active)
 *   4. If batch fails, release all reservations (no orphaned holds)
 */
export async function createOrder(db: Database, data: CreateOrderInput): Promise<{ id: string }> {
    const currentCurrency = await getCurrencySettings(db);
    const currency = createOrderCurrencySnapshot(currentCurrency.currencyCode);
    const money = calculateManualOrderMoney(
        data.items,
        data.shippingCharge,
        data.discountAmount,
        currency,
    );
    const totalAmount = money.totalAmount;
    const initialPaymentState = computeOrderPaymentState({
        totalAmount,
        paidAmount: 0,
        currency,
    });

    const { cityName, zoneName, areaName } = await resolveActiveDeliveryLocationNames(db, data);

    // Get or create customer (read outside batch, writes inside)
    const existingCustomer = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, data.customerPhone))
        .get();

    let customerId = existingCustomer?.id;

    // Pre-compute customer stats if existing customer
    let customerStats: { totalOrders: number; totalSpent: number; lastOrderAt: Date | null } | null = null;
    if (existingCustomer) {
        const customerOrders = await db
            .select({ paidAmount: orders.paidAmount, createdAt: orders.createdAt })
            .from(orders)
            .where(and(
                eq(orders.customerId, existingCustomer.id),
                isNull(orders.deletedAt),
            ));

        const allOrders = [
            ...customerOrders,
            { paidAmount: initialPaymentState.paidAmount, createdAt: new Date() },
        ];
        customerStats = calculateCustomerStats(allOrders);
    }

    // ── Pre-validate and reserve inventory ─────────────────────────────
    // Reserve stock BEFORE inserting the order. This validates availability
    // and holds stock atomically. If any variant has insufficient stock,
    // the order creation fails immediately with a clear error.
    const orderId = generateOrderId();
    const trackedItems = await resolveAdminOrderItemInventory(db, money.normalizedItems);
    const reservationEntries: ReservationEntry[] = trackedItems
        .filter((item) => item.inventoryTracked)
        .map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            pool: "regular" as const,
        }));

    if (reservationEntries.length > 0) {
        const batchItems = reservationEntries.map(e => ({
            variantId: e.variantId,
            quantity: e.quantity,
            orderId,
        }));
        const reserveResult = await reserveStockBatch(
            db,
            batchItems,
            "regular",
            { reservationKey: `admin-order-create:v1:${orderId}` },
        );
        if (!reserveResult.success) {
            throw new ValidationError(
                reserveResult.error ?? "Insufficient stock for one or more items",
            );
        }
    }

    // ── Atomic batch: customer + order + items ──────────────────────────
    // D1 batch() executes all statements in a single atomic operation.
    // If any statement fails, none are committed.
    const writeBatch: SQLiteBatchItem[] = [];

    if (!existingCustomer) {
        customerId = "cust_" + nanoid();
        writeBatch.push(
            db.insert(customers).values({
                id: customerId,
                name: data.customerName,
                phone: data.customerPhone,
                email: data.customerEmail,
                address: data.shippingAddress,
                city: data.city,
                zone: data.zone,
                area: data.area,
                totalOrders: 1,
                totalSpent: initialPaymentState.paidAmount,
                lastOrderAt: sql`unixepoch()`,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
        );
        writeBatch.push(
            db.insert(customerHistory).values({
                id: "hist_" + nanoid(),
                customerId: customerId!,
                name: data.customerName,
                email: data.customerEmail,
                phone: data.customerPhone,
                address: data.shippingAddress,
                city: data.city,
                zone: data.zone,
                area: data.area,
                changeType: "created",
                createdAt: sql`unixepoch()`,
            }),
        );
    } else {
        writeBatch.push(
            db.update(customers).set({
                totalOrders: customerStats!.totalOrders,
                totalSpent: customerStats!.totalSpent,
                lastOrderAt: customerStats!.lastOrderAt ? sql`${Math.floor(customerStats!.lastOrderAt.getTime() / 1000)}` : null,
                updatedAt: sql`unixepoch()`,
            }).where(eq(customers.id, existingCustomer.id)),
        );
        writeBatch.push(
            db.insert(customerHistory).values({
                id: "hist_" + nanoid(),
                customerId: existingCustomer.id,
                name: data.customerName,
                email: data.customerEmail,
                phone: data.customerPhone,
                address: data.shippingAddress,
                city: data.city,
                zone: data.zone,
                area: data.area,
                changeType: "updated",
                createdAt: sql`unixepoch()`,
            }),
        );
    }

    // Order row
    writeBatch.push(
        db.insert(orders).values({
            id: orderId,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            shippingAddress: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName,
            zoneName,
            areaName,
            notes: data.notes,
            totalAmount,
            shippingCharge: money.shippingCharge,
            discountAmount: money.discountAmount,
            currencyCode: currency.code,
            currencyDecimalPlaces: currency.decimalPlaces,
            subtotalAmountMinor: money.subtotalAmountMinor,
            shippingAmountMinor: money.shippingAmountMinor,
            discountAmountMinor: money.discountAmountMinor,
            taxAmountMinor: 0,
            totalAmountMinor: money.totalAmountMinor,
            taxLabel: null,
            pricesIncludeTax: false,
            paidAmount: initialPaymentState.paidAmount,
            balanceDue: initialPaymentState.balanceDue,
            paymentStatus: initialPaymentState.paymentStatus,
            status: "pending",
            customerId,
            inventoryAction: reservationEntries.length > 0 ? "reserved" : "none",
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
    );

    // Order items
    if (data.items.length > 0) {
        writeBatch.push(
            db.insert(orderItems).values(
                trackedItems.map((item) => ({
                    id: generateOrderId(),
                    orderId,
                    productId: item.productId,
                    variantId: item.variantId,
                    productImageMediaId: item.productImageMediaId,
                    quantity: item.quantity,
                    price: item.price,
                    productName: item.productName,
                    variantLabel: item.variantLabel,
                    inventoryTracked: item.inventoryTracked,
                    createdAt: sql`unixepoch()`,
                })),
            ),
        );
    }

    try {
        await safeBatch(db, writeBatch);
    } catch (batchError) {
        // DB write failed -- prove any reservations we made were released.
        if (reservationEntries.length > 0) {
            const releaseResult = await releaseReservedStockBatch(db, reservationEntries, orderId, {
                releaseKey: ADMIN_CREATE_ROLLBACK_RELEASE_KEY,
            });
            if (!releaseResult.success) {
                console.error("[orders.admin] Failed to prove reserved stock release after manual order create failure:", {
                    orderId,
                    error: releaseResult.error,
                    manualReconciliationRequired: releaseResult.manualReconciliationRequired,
                });
                throw new ServiceUnavailableError("Manual order inventory cleanup is temporarily unavailable. Please try again.");
            }
        }
        throw batchError;
    }

    // ── Convert reservations to permanent deductions ────────────────────
    // Admin orders are immediately active. Route the conversion through the
    // claimed order transition engine so a Worker retry cannot deduct twice.
    if (reservationEntries.length > 0) {
        try {
            await applyInventoryForStatusChange(db, orderId, OrderStatus.SHIPPED);
        } catch (error: unknown) {
            // The order remains reserved when the strict deduction cannot be
            // proven, which fails safe against overselling.
            console.error(
                `[orders.admin] Failed to prove stock deduction for order ${orderId}. Stock remains reserved.`,
                error,
            );
        }
    }

    return { id: orderId };
}

interface UpdateOrderItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
    inventoryTracked?: boolean;
}

interface UpdateOrderData {
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    shippingAddress: string;
    city: string;
    zone: string;
    area: string | null;
    cityName?: string;
    zoneName?: string;
    areaName?: string;
    notes: string | null;
    items: UpdateOrderItem[];
    shippingCharge: number;
    discountAmount: number;
    status: string;
}

function buildInventoryEntries(
    items: { variantId: string | null; quantity: number; inventoryTracked?: boolean }[],
    pool: NonNullable<ReservationEntry["pool"]>,
): ReservationEntry[] {
    const merged = new Map<string, number>();
    for (const item of items) {
        if (!item.variantId || item.inventoryTracked === false) continue;
        merged.set(item.variantId, (merged.get(item.variantId) ?? 0) + item.quantity);
    }
    return Array.from(merged.entries()).map(([variantId, quantity]) => ({ variantId, quantity, pool }));
}

function computeInventoryDeltas(
    oldEntries: ReservationEntry[],
    newEntries: ReservationEntry[],
    pool: NonNullable<ReservationEntry["pool"]>,
): { positiveEntries: ReservationEntry[]; negativeEntries: ReservationEntry[] } {
    const deltaMap = new Map<string, number>();
    for (const entry of oldEntries) {
        deltaMap.set(entry.variantId, (deltaMap.get(entry.variantId) ?? 0) - entry.quantity);
    }
    for (const entry of newEntries) {
        deltaMap.set(entry.variantId, (deltaMap.get(entry.variantId) ?? 0) + entry.quantity);
    }

    const positiveEntries: ReservationEntry[] = [];
    const negativeEntries: ReservationEntry[] = [];
    for (const [variantId, delta] of deltaMap) {
        if (delta > 0) {
            positiveEntries.push({ variantId, quantity: delta, pool });
        } else if (delta < 0) {
            negativeEntries.push({ variantId, quantity: Math.abs(delta), pool });
        }
    }

    return { positiveEntries, negativeEntries };
}

function toReservationBatchItems(entries: ReservationEntry[], orderId: string) {
    return entries.map((entry) => ({
        variantId: entry.variantId,
        quantity: entry.quantity,
        orderId,
    }));
}

function groupEntriesByPool(entries: ReservationEntry[]) {
    const groups = new Map<NonNullable<ReservationEntry["pool"]>, ReservationEntry[]>();
    for (const entry of entries) {
        const pool = entry.pool ?? "regular";
        const group = groups.get(pool) ?? [];
        group.push({ ...entry, pool });
        groups.set(pool, group);
    }
    return groups;
}

function adminOrderInventoryClaimKey(
    orderId: string,
    expectedVersion: number,
    purpose: string,
): string {
    return `admin-order-edit:v1:${orderId}:v${expectedVersion}:${purpose}`;
}

async function reserveEntriesForCompensation(
    db: Database,
    orderId: string,
    expectedVersion: number,
    entries: ReservationEntry[],
    purpose: string,
): Promise<{ success: boolean; error?: string }> {
    const reserved: ReservationEntry[] = [];
    for (const [pool, group] of groupEntriesByPool(entries)) {
        const result = await reserveStockBatch(
            db,
            toReservationBatchItems(group, orderId),
            pool,
            { reservationKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `${purpose}:reserve:${pool}`) },
        );
        if (!result.success) {
            if (reserved.length > 0) {
                await releaseReservedStockBatch(db, reserved, orderId, {
                    releaseKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `${purpose}:rollback`),
                });
            }
            return { success: false, error: result.error };
        }
        reserved.push(...group);
    }
    return { success: true };
}

async function redeductRestoredEntriesForCompensation(
    db: Database,
    orderId: string,
    expectedVersion: number,
    entries: ReservationEntry[],
    purpose: string,
): Promise<{ success: boolean; error?: string }> {
    const preorderEntries = entries.filter((entry) => (entry.pool ?? "regular") === "preorder");
    const directEntries = entries.filter((entry) => (entry.pool ?? "regular") !== "preorder");

    if (preorderEntries.length > 0) {
        const reserveResult = await reserveEntriesForCompensation(
            db,
            orderId,
            expectedVersion,
            preorderEntries,
            `${purpose}:preorder`,
        );
        if (!reserveResult.success) {
            return reserveResult;
        }
        try {
            await applyClaimedInventoryEntryBatch(db, {
                orderId,
                operation: "deduct",
                entries: preorderEntries,
                claimKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `${purpose}:deduct:preorder`),
                pool: "preorder",
            });
        } catch (error: unknown) {
            await releaseReservedStockBatch(db, preorderEntries, orderId, {
                releaseKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `${purpose}:deduct-rollback:preorder`),
            });
            return { success: false, error: error instanceof Error ? error.message : "Failed to re-deduct preorder stock" };
        }
    }

    if (directEntries.length > 0) {
        try {
            for (const [pool, group] of groupEntriesByPool(directEntries)) {
                await applyClaimedInventoryEntryBatch(db, {
                    orderId,
                    operation: "deduct",
                    entries: group,
                    claimKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `${purpose}:deduct:${pool}`),
                    pool,
                });
            }
        } catch (error: unknown) {
            return { success: false, error: error instanceof Error ? error.message : "Failed to re-deduct stock" };
        }
    }

    return { success: true };
}

async function releaseReservationsForOrderEdit(
    db: Database,
    orderId: string,
    expectedVersion: number,
    entries: ReservationEntry[],
    purpose: string,
    errorMessage: string,
): Promise<void> {
    if (entries.length === 0) return;
    const result = await releaseReservedStockBatch(db, entries, orderId, {
        releaseKey: adminOrderInventoryClaimKey(orderId, expectedVersion, purpose),
    });
    if (!result.success) {
        throw new ValidationError(result.error ?? errorMessage);
    }
}

async function restoreDeductedForOrderEdit(
    db: Database,
    orderId: string,
    expectedVersion: number,
    entries: ReservationEntry[],
    purpose: string,
    errorMessage: string,
): Promise<void> {
    if (entries.length === 0) return;
    try {
        for (const [pool, group] of groupEntriesByPool(entries)) {
            await applyClaimedInventoryEntryBatch(db, {
                orderId,
                operation: "restore",
                entries: group,
                claimKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `${purpose}:${pool}`),
                pool,
            });
        }
    } catch (error: unknown) {
        throw new ValidationError(error instanceof Error ? error.message : errorMessage);
    }
}

async function compensatePreWriteInventory(
    db: Database,
    orderId: string,
    expectedVersion: number,
    acquiredReservations: ReservationEntry[],
    deductedEntries: ReservationEntry[],
    releasedReservations: ReservationEntry[],
    restoredDeductedEntries: ReservationEntry[],
) {
    if (restoredDeductedEntries.length > 0) {
        const redeductResult = await redeductRestoredEntriesForCompensation(
            db,
            orderId,
            expectedVersion,
            restoredDeductedEntries,
            "compensate-restored",
        );
        if (!redeductResult.success) {
            console.error(`[orders.admin] Failed to compensate restored deducted stock for order ${orderId}: ${redeductResult.error}`);
        }
    }
    if (releasedReservations.length > 0) {
        const reserveResult = await reserveEntriesForCompensation(
            db,
            orderId,
            expectedVersion,
            releasedReservations,
            "compensate-released",
        );
        if (!reserveResult.success) {
            console.error(`[orders.admin] Failed to compensate released reservations for order ${orderId}: ${reserveResult.error}`);
        }
    }
    if (deductedEntries.length > 0) {
        try {
            for (const [pool, group] of groupEntriesByPool(deductedEntries)) {
                await applyClaimedInventoryEntryBatch(db, {
                    orderId,
                    operation: "restore",
                    entries: group,
                    claimKey: adminOrderInventoryClaimKey(orderId, expectedVersion, `compensate-deducted:${pool}`),
                    pool,
                });
            }
        } catch (error: unknown) {
            console.error(`[orders.admin] Failed to compensate deducted stock for order ${orderId}:`, error);
        }
    }
    if (acquiredReservations.length > 0) {
        const releaseResult = await releaseReservedStockBatch(db, acquiredReservations, orderId, {
            releaseKey: adminOrderInventoryClaimKey(orderId, expectedVersion, "compensate-acquired"),
        });
        if (!releaseResult.success) {
            console.error(`[orders.admin] Failed to compensate reserved stock for order ${orderId}: ${releaseResult.error}`);
        }
    }
}

export async function updateOrder(db: Database, id: string, data: UpdateOrderData): Promise<{ id: string }> {
    const { cityName, zoneName, areaName } = await resolveActiveDeliveryLocationNames(db, data);

    const existingOrder = await db
        .select({
            id: orders.id,
            customerId: orders.customerId,
            customerPhone: orders.customerPhone,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            paidAmount: orders.paidAmount,
            paymentStatus: orders.paymentStatus,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`)
        .get();

    if (!existingOrder) throw new NotFoundError("Order not found");
    const currentStatus = normalizeOrderStatus(existingOrder.status);
    if (!currentStatus) {
        throw new ValidationError("Order has an unknown current status.");
    }
    const nextStatus = normalizeOrderStatus(data.status);
    if (!nextStatus) {
        throw new ValidationError("Unknown order status.");
    }
    assertNoActiveShipmentClaim(existingOrder);
    await assertNoActiveRefundAttempt(db, id);
    await assertNoActivePaymentSessionAttempt(db, id);
    await assertOrderItemsHaveNoReturnHistory(db, id);
    await assertOrderHasNoIssuedInvoice(db, id);

    const currency = resolveOrderCurrencySnapshot(existingOrder);
    const money = calculateManualOrderMoney(
        data.items,
        data.shippingCharge,
        data.discountAmount,
        currency,
    );

    // Validate status transition if status is changing
    if (nextStatus !== currentStatus) {
        assertGenericAdminOrderStatusTransition(currentStatus, nextStatus);
        validateTransition("order", currentStatus, nextStatus);
    }

    const existingItems = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
    const trackedNewItems = await resolveAdminOrderItemInventory(db, money.normalizedItems);
    const pool = (existingOrder.inventoryPool as "regular" | "preorder" | "backorder") ?? "regular";
    const existingInventoryAction = existingOrder.inventoryAction as string;
    const targetRestoresStock = isStockRestoreStatus(nextStatus);
    const targetDeductsStock = isStockDeductStatus(nextStatus);
    const oldEntries = buildInventoryEntries(existingItems, pool);
    const newEntries = buildInventoryEntries(trackedNewItems, pool);
    const { positiveEntries, negativeEntries } = computeInventoryDeltas(oldEntries, newEntries, pool);

    const totalAmount = money.totalAmount;
    const nextPaymentState = computeOrderPaymentState({
        totalAmount,
        paidAmount: existingOrder.paidAmount,
        paymentStatus: existingOrder.paymentStatus === PaymentStatus.REFUNDED
            ? PaymentStatus.REFUNDED
            : existingOrder.paymentStatus === PaymentStatus.FAILED
                ? PaymentStatus.FAILED
                : undefined,
        currency,
    });
    let customerId = existingOrder.customerId;
    let newCustomerId: string | null = null;
    let acquiredReservations: ReservationEntry[] = [];
    let deductedEntries: ReservationEntry[] = [];
    let releasedReservations: ReservationEntry[] = [];
    let restoredDeductedEntries: ReservationEntry[] = [];
    let inventoryActionOverride: string | null = null;
    let statusTransitionHandled = false;
    let writesCommitted = false;

    try {
        if (existingInventoryAction === "reserved" && !targetRestoresStock && positiveEntries.length > 0) {
            const availability = await validateStockBatchAvailability(db, toReservationBatchItems(positiveEntries, id), pool);
            if (!availability.success) {
                throw new ValidationError(availability.error ?? "Insufficient stock for updated items");
            }

            const reserveResult = await reserveStockBatch(
                db,
                toReservationBatchItems(positiveEntries, id),
                pool,
                { reservationKey: adminOrderInventoryClaimKey(id, existingOrder.version, "reserve-positive") },
            );
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock for updated items");
            }
            acquiredReservations = positiveEntries;
        }

        if (existingInventoryAction === "deducted" && !targetRestoresStock && positiveEntries.length > 0) {
            const reserveResult = await reserveStockBatch(
                db,
                toReservationBatchItems(positiveEntries, id),
                pool,
                { reservationKey: adminOrderInventoryClaimKey(id, existingOrder.version, "reserve-positive-deducted") },
            );
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock for updated items");
            }
            acquiredReservations = positiveEntries;

            try {
                await applyClaimedInventoryEntryBatch(db, {
                    orderId: id,
                    operation: "deduct",
                    entries: positiveEntries,
                    claimKey: adminOrderInventoryClaimKey(id, existingOrder.version, "deduct-positive"),
                    pool,
                });
            } catch (error: unknown) {
                await compensatePreWriteInventory(db, id, existingOrder.version, acquiredReservations, [], [], []);
                acquiredReservations = [];
                throw new ValidationError(
                    error instanceof Error ? error.message : "Failed to deduct additional stock for updated items",
                );
            }
            acquiredReservations = [];
            deductedEntries = positiveEntries;
        }

        if (existingInventoryAction === "restored" && !targetRestoresStock && !targetDeductsStock && newEntries.length > 0) {
            const reserveResult = await reserveStockBatch(
                db,
                toReservationBatchItems(newEntries, id),
                pool,
                { reservationKey: adminOrderInventoryClaimKey(id, existingOrder.version, "reserve-reactivation") },
            );
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock to reactivate order");
            }
            acquiredReservations = newEntries;
        }

        if (existingInventoryAction === "reserved") {
            if (targetRestoresStock) {
                await releaseReservationsForOrderEdit(
                    db,
                    id,
                    existingOrder.version,
                    oldEntries,
                    "release-all",
                    "Failed to release order reservations",
                );
                releasedReservations = oldEntries;
                inventoryActionOverride = "restored";
                statusTransitionHandled = true;
            } else if (negativeEntries.length > 0) {
                await releaseReservationsForOrderEdit(
                    db,
                    id,
                    existingOrder.version,
                    negativeEntries,
                    "release-negative",
                    "Failed to release removed reservations",
                );
                releasedReservations = negativeEntries;
            }
        } else if (existingInventoryAction === "deducted") {
            if (targetRestoresStock) {
                await restoreDeductedForOrderEdit(
                    db,
                    id,
                    existingOrder.version,
                    oldEntries,
                    "restore-all",
                    "Failed to restore deducted stock",
                );
                restoredDeductedEntries = oldEntries;
                inventoryActionOverride = "restored";
                statusTransitionHandled = true;
            } else if (negativeEntries.length > 0) {
                await restoreDeductedForOrderEdit(
                    db,
                    id,
                    existingOrder.version,
                    negativeEntries,
                    "restore-negative",
                    "Failed to restore removed deducted stock",
                );
                restoredDeductedEntries = negativeEntries;
            }
        } else if (existingInventoryAction === "restored" && !targetRestoresStock && !targetDeductsStock && newEntries.length > 0) {
            inventoryActionOverride = "reserved";
            statusTransitionHandled = true;
        }

        if (data.customerPhone !== existingOrder.customerPhone) {
            const customer = await db.select().from(customers).where(eq(customers.phone, data.customerPhone)).get();
            if (customer) {
                customerId = customer.id;
            } else {
                newCustomerId = "cust_" + nanoid();
                customerId = newCustomerId;
            }
        }

        const committedOrderVersion = existingOrder.version + 1;
        const atomicEditStatements: SQLiteBatchItem[] = [];
        if (newCustomerId) {
            atomicEditStatements.push(buildGuardedCustomerInsert(
                db,
                id,
                newCustomerId,
                data,
                totalAmount,
                existingOrder.version,
            ));
        }

        const orderUpdateResultIndex = atomicEditStatements.length;
        atomicEditStatements.push(
            db.update(orders).set({
                customerName: data.customerName,
                customerPhone: data.customerPhone,
                customerEmail: data.customerEmail,
                shippingAddress: data.shippingAddress,
                city: data.city,
                zone: data.zone,
                area: data.area,
                cityName,
                zoneName,
                areaName,
                notes: data.notes,
                totalAmount,
                shippingCharge: money.shippingCharge,
                discountAmount: money.discountAmount,
                currencyCode: currency.code,
                currencyDecimalPlaces: currency.decimalPlaces,
                subtotalAmountMinor: money.subtotalAmountMinor,
                shippingAmountMinor: money.shippingAmountMinor,
                discountAmountMinor: money.discountAmountMinor,
                taxAmountMinor: 0,
                totalAmountMinor: money.totalAmountMinor,
                taxLabel: null,
                pricesIncludeTax: false,
                paidAmount: nextPaymentState.paidAmount,
                balanceDue: nextPaymentState.balanceDue,
                paymentStatus: nextPaymentState.paymentStatus,
                status: nextStatus,
                customerId,
                version: committedOrderVersion,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, id),
                eq(orders.version, existingOrder.version),
                noActiveRefundAttemptForOrderIdCondition(id),
                noActivePaymentSessionAttemptForOrderIdCondition(id),
            )).returning({ id: orders.id }),
        );

        for (const item of trackedNewItems) {
            atomicEditStatements.push(buildGuardedOrderItemInsert(db, id, committedOrderVersion, item));
        }

        const guardedOldItemsDelete = buildGuardedOrderItemsDelete(db, id, committedOrderVersion, existingItems);
        if (guardedOldItemsDelete) {
            atomicEditStatements.push(guardedOldItemsDelete);
        }

        const batchResults = await safeBatch(db, atomicEditStatements) as unknown[];
        const updateResult = batchResults[orderUpdateResultIndex] as Array<{ id: string }> | undefined;

        if ((updateResult?.length ?? 0) === 0) {
            throw new ConflictError("Order was modified by another request. Please reload and try again.");
        }
        writesCommitted = true;

        if (!statusTransitionHandled) {
            inventoryActionOverride = await applyInventoryForStatusChange(db, id, nextStatus);
        }

        if (inventoryActionOverride) {
            await db.update(orders)
                .set({ inventoryAction: inventoryActionOverride })
                .where(eq(orders.id, id));
        }

        if (existingOrder.customerId) {
            await updateCustomerStatsService(db, existingOrder.customerId);
        }
        if (customerId && customerId !== existingOrder.customerId) {
            await updateCustomerStatsService(db, customerId);
        }

        return { id };
    } catch (error) {
        if (!writesCommitted) {
            try {
                await compensatePreWriteInventory(
                    db,
                    id,
                    existingOrder.version,
                    acquiredReservations,
                    deductedEntries,
                    releasedReservations,
                    restoredDeductedEntries,
                );
            } catch (compensationError) {
                console.error(`[orders.admin] Inventory compensation failed after order update error for ${id}:`, compensationError);
            }
        }
        throw error;
    }
}

async function updateCustomerStatsService(db: Database, customerId: string) {
    const customerOrders = await db.select({ paidAmount: orders.paidAmount, createdAt: orders.createdAt })
        .from(orders).where(and(
            eq(orders.customerId, customerId),
            isNull(orders.deletedAt),
        ));
    const stats = calculateCustomerStats(customerOrders);
    await db.update(customers).set({
        totalOrders: stats.totalOrders,
        totalSpent: stats.totalSpent,
        lastOrderAt: stats.lastOrderAt ? sql`${Math.floor(stats.lastOrderAt.getTime() / 1000)}` : null,
        updatedAt: sql`unixepoch()`,
    }).where(eq(customers.id, customerId));
}

export async function deleteOrder(db: Database, id: string) {
    const orderToDelete = await db.select({
        id: orders.id,
        inventoryAction: orders.inventoryAction,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(sql`${orders.id} = ${id} AND ${orders.deletedAt} IS NULL`).get();
    if (!orderToDelete) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(orderToDelete);
    await assertNoActiveRefundAttempt(db, id);
    await assertNoActivePaymentSessionAttemptsForOrders(db, [id]);
    await assertNoActiveReturnReceipt(db, id);
    if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.update(orders).set({ deletedAt: sql`unixepoch()`, inventoryAction: "restored", version: sql`${orders.version} + 1`, updatedAt: sql`unixepoch()` }).where(eq(orders.id, id));
}

export async function restoreOrder(db: Database, id: string) {
    // Load the order to check its current inventory state
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            inventoryPool: orders.inventoryPool,
            deletedAt: orders.deletedAt,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    if (!order.deletedAt) throw new ValidationError("Order is not deleted");
    await assertNoActiveRefundAttempt(db, id);
    await assertNoActivePaymentSessionAttempt(db, id);

    let nextInventoryAction = order.inventoryAction as "none" | "reserved" | "deducted" | "restored";
    let reservedEntries: ReservationEntry[] = [];

    if (order.inventoryAction === "restored") {
        if (isStockReservableStatus(order.status)) {
            const items = await db
                .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
                .from(orderItems)
                .where(eq(orderItems.orderId, id));

            const pool = (order.inventoryPool as "regular" | "preorder" | "backorder") ?? "regular";
            const entries: ReservationEntry[] = items
                .filter((i): i is typeof i & { variantId: string } => i.variantId !== null)
                .map((i) => ({
                    variantId: i.variantId,
                    quantity: i.quantity,
                    pool,
                }));

            if (entries.length > 0) {
                const batchItems = entries.map(e => ({
                    variantId: e.variantId,
                    quantity: e.quantity,
                    orderId: id,
                }));
                const reserveResult = await reserveStockBatch(
                    db,
                    batchItems,
                    pool,
                    { reservationKey: adminOrderInventoryClaimKey(id, order.version, "trash-restore") },
                );
                if (!reserveResult.success) {
                    throw new ValidationError(
                        `Cannot restore order: ${reserveResult.error ?? "insufficient stock to re-reserve inventory"}`,
                    );
                }
                reservedEntries = entries;
                nextInventoryAction = "reserved";
            } else {
                nextInventoryAction = "none";
            }
        } else {
            assertTrashRestoreInventoryActionAllowed(order.status, order.inventoryAction);
            nextInventoryAction = "restored";
        }
    } else {
        assertTrashRestoreInventoryActionAllowed(order.status, order.inventoryAction);
    }

    const restoreResult = await db.update(orders)
        .set({ deletedAt: null, inventoryAction: nextInventoryAction, version: sql`${orders.version} + 1`, updatedAt: sql`unixepoch()` })
        .where(and(
            eq(orders.id, id),
            eq(orders.version, order.version),
            isNotNull(orders.deletedAt),
            noActiveRefundAttemptForOrderIdCondition(id),
            noActivePaymentSessionAttemptForOrderIdCondition(id),
        ))
        .returning({ id: orders.id });

    if (restoreResult.length === 0) {
        if (reservedEntries.length > 0) {
            const releaseResult = await releaseReservedStockBatch(db, reservedEntries, id, {
                releaseKey: adminOrderInventoryClaimKey(id, order.version, "trash-restore-cas-rollback"),
            });
            if (!releaseResult.success) {
                console.error(`[orders.admin] Failed to compensate restore reservation for ${id}:`, releaseResult.error);
            }
        }
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }
}

export async function permanentlyDeleteOrder(db: Database, id: string) {
    const orderToDelete = await db.select({
        inventoryAction: orders.inventoryAction,
        deletedAt: orders.deletedAt,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, id)).get();
    if (!orderToDelete) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(orderToDelete);
    await assertNoActiveRefundAttempt(db, id);
    await assertNoActivePaymentSessionAttemptsForOrders(db, [id]);
    await assertOrderItemsHaveNoReturnHistory(db, id);
    await assertOrderHasNoIssuedInvoice(db, id);
    if (!orderToDelete.deletedAt) throw new ValidationError("Order must be soft-deleted before permanent deletion");
    if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted") {
        await applyInventoryForStatusChange(db, id, "cancelled");
    }
    await db.delete(orderItems).where(eq(orderItems.orderId, id));
    await db.delete(orders).where(eq(orders.id, id));
}

export async function bulkDeleteOrders(db: Database, orderIds: string[], permanent: boolean = false) {
    if (orderIds.length === 0) return;

    // Batch-read ALL affected orders in ONE query (Fix N+1)
    const affectedOrders = await db
        .select({
            id: orders.id,
            inventoryAction: orders.inventoryAction,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(inArray(orders.id, orderIds));

    const claimedOrders = affectedOrders.filter((order) => hasActiveShipmentClaim(order));
    if (claimedOrders.length > 0) {
        throw new ConflictError(`Orders have active shipment creation in progress: ${claimedOrders.map((order) => order.id).join(", ")}`);
    }
    await assertNoActiveRefundAttemptsForOrders(db, affectedOrders.map((order) => order.id));
    await assertNoActivePaymentSessionAttemptsForOrders(db, affectedOrders.map((order) => order.id));
    for (const order of affectedOrders) {
        if (permanent) {
            await assertOrderItemsHaveNoReturnHistory(db, order.id);
            await assertOrderHasNoIssuedInvoice(db, order.id);
        }
        else await assertNoActiveReturnReceipt(db, order.id);
    }

    // Apply inventory transitions for orders that need it
    // (applyInventoryForStatusChange reads order items internally and uses CAS operations)
    for (const order of affectedOrders) {
        if (order.inventoryAction === "reserved" || order.inventoryAction === "deducted") {
            await applyInventoryForStatusChange(db, order.id, "cancelled");
        }
    }

    // Batch the final delete/soft-delete statements atomically (Fix atomicity)
    if (permanent) {
        const deleteStmts: SQLiteBatchItem[] = [
            db.delete(orderItems).where(inArray(orderItems.orderId, orderIds)),
            db.delete(orders).where(inArray(orders.id, orderIds)),
        ];
        await safeBatch(db, deleteStmts);
    } else {
        await db.update(orders)
            .set({
                deletedAt: sql`unixepoch()`,
                inventoryAction: "restored",
                version: sql`${orders.version} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(inArray(orders.id, orderIds));
    }
}
