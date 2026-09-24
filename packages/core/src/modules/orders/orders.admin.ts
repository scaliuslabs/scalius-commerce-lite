// src/modules/orders/orders.admin.ts
// Admin order service: queries and CRUD mutations.

import { nextOrderNumberSql } from "./order-number";
import {
    buildBatchGuard,
    isBatchGuardError,
    safeBatch,
    type Database,
} from "@scalius/database/client";
import {
    orders,
    orderItems,
    orderAmendments,
    orderInvoices,
    orderReturns,
    orderReturnLines,
    orderSupportRequests,
    orderTaxSnapshots,
    orderItemTaxSnapshots,
    customers,
    customerHistory,
    products,
    productVariants,
    media,
    deliveryShipments,
    deliveryProviders,
    paymentSessionAttempts,
    orderPayments,
    codTracking,
    refundAttempts,
    paymentPlans,
    webhookEvents,
    orderDiscountAllocations,
    CodStatus,
    OrderStatus,
    PaymentMethod,
    PaymentPlanStatus,
    PaymentRecordStatus,
    PaymentStatus,
    FulfillmentStatus,
    ItemFulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import {
    prepareStockReservationBatch,
    prepareReservedStockReleaseBatch,
    isInventoryReservationConflictError,
    isPreparedReservedStockReleaseConflictError,
} from "../inventory";
import type { ReservationEntry } from "../inventory";
import { getPaymentGateway, isOnlinePaymentMethod, listPaymentGateways } from "../payments/gateways/registry";

import { sql, desc, eq, inArray, isNotNull, isNull, notInArray, and, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
    ftsMatch,
    isFts5SearchEnabled,
    sanitizeFtsQuery,
} from "../../search/fts5";
import { generateOrderId } from "@scalius/shared/order-utils";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
import { discountedPriceMinor, fromMinor, toMinor } from "@scalius/shared/money";
import { storeCurrencyCodeSql, storeCurrencyFromCode } from "../products/products.money";
import { normalizeOrderStatus } from "@scalius/shared/order-state";
import { unixToDate } from "@scalius/shared/utils";
import { nanoid } from "nanoid";
import type {
    UpdateOrderDetailsInput,
    ArchiveOrdersInput,
    CreateOrderInput,
    ConfirmManualOrderAmendmentInput,
    PreviewManualOrderAmendmentInput,
    QuoteManualOrderInput,
} from "./orders.validation";
import { chunkRowsForD1 } from "./d1-write-chunks";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import type {
    OrderDetails,
    OrderListItem,
    OrderEditLockReason,
    OrderEditReadiness,
    OrderPaymentRecoveryFilter,
    OrderPaymentRecoverySummary,
    OrderShipmentRecoverySummary,
    OrderShipmentSummary,
} from "./orders.types";
import { orderNumberSearchCondition } from "./order-number";
import { recordOrderEvent } from "./order-timeline";
import { buildPhoneSearchTerms, isLikelyPhoneSearch } from "./orders.search";
import { assertNoActiveShipmentClaim, hasActiveShipmentClaim } from "./shipment-claim";
import { PROVIDER_OUTCOME_UNKNOWN } from "../delivery/types";
import { computeOrderPaymentState } from "../payments/payment-state";
import { createCODTrackingInsertValues } from "../payments/cod";
import {
    createOrderCurrencySnapshot,
    resolveOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "../payments/order-currency";
import { orderMoneyAmounts, orderMoneySelection } from "./order-money";
import { getCurrencySettings } from "../settings/site-settings.service";
import { validateCustomerPhoneCountry } from "../settings/phone-country-policy";
import {
    buildStorefrontTaxAllocationLineId,
    calculateStorefrontTaxQuote,
    type TaxQuote,
} from "../tax";
import {
    assertNoActiveRefundAttemptsForOrders,
    noActiveRefundAttemptForOrderIdCondition,
    noActiveRefundAttemptForOrderColumnCondition,
} from "../payments/refund-attempt-guard";
import {
    listOrderRefundAttempts,
    resolveActiveRefundOperationsForOrders,
    selectActiveRefundAttemptRowsForOrders,
    summarizeActiveRefundOperation,
    type RefundAttemptVisibilityRow,
} from "../payments/refund-attempt-visibility";
import { variantOptionLabelSql } from "../products/products.option-model";
import {
    loadProductMediaProjections,
    resolveSkuImageRepresentation,
} from "../products/products.media";
import {
    activePaymentSessionAttemptExistsCondition,
    assertNoActivePaymentSessionAttemptsForOrders,
    noActivePaymentSessionAttemptForOrderIdCondition,
    listOrderPaymentSessionAttempts,
} from "../payments/payment-session-attempts";
import { PAYMENT_BLOCKED_ORDER_STATUSES } from "../payments/payable-order";
import { resolveActiveDeliveryLocationNames } from "./delivery-location-validation";
import { listOrderSupportRequests } from "./order-support-requests";
import { createOrderReceiptToken, recordOrderReceipt } from "./order-receipts";
import { assertNoActiveReturnReceipt } from "./order-returns";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import { publishedMediaObjectKey } from "../media/media.presentation";
import { retryTransientD1 } from "../../utils/transient-d1";
import {
    buildAdminOrderCreateAttemptCommit,
    buildAdminOrderCreateAttemptGuard,
    buildAdminOrderCreateAttemptIdentity,
    claimAdminOrderCreateAttempt,
    isAdminOrderCreateAttemptGuardError,
    markAdminOrderCreateAttemptFailed,
    resolveAdminOrderCreateAttempt,
    sha256Hex,
    stableStringify,
} from "./admin-order-create-attempts";
import { getOrderArchiveStatusBlockedReason } from "./order-archive-policy";

// ─────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────

type SQLiteBatchItem = BatchItem<"sqlite">;
const MAX_ORDER_LIST_LIMIT = 100;
const ORDER_ITEM_INSERT_PARAMETERS_PER_ROW = 18;
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = 7;
const ORDER_AMENDMENT_GUARD_MARKER = "ORDER_AMENDMENT_CONFLICT";

const OPEN_ORDER_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);
const SENT_ORDER_STATUSES = new Set<string>([
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.COMPLETED,
]);

/** Facts that decide what a merchant may still change on an order. */
export interface OrderEditSource {
    status: string;
    paymentMethod: string | null;
    paymentStatus: string | null;
    paidAmountMinor: number;
    fulfillmentStatus: string | null;
    inventoryAction: string | null;
    shipmentClaimId: string | null;
    archivedAt: unknown;
    hasTaxSnapshot: number | boolean;
    hasPaymentHistory: number | boolean;
    hasPaymentSessionHistory: number | boolean;
    hasShipmentHistory: number | boolean;
    hasRefundHistory: number | boolean;
    hasReturnHistory: number | boolean;
    hasInvoiceHistory: number | boolean;
    hasPaymentPlan: number | boolean;
    hasPromotionAllocation: number | boolean;
    hasNonPendingItem: number | boolean;
    hasCleanCodTracking: number | boolean;
}

function editState(reason: OrderEditLockReason | null) {
    return { allowed: reason === null, reason };
}

/**
 * Customer and delivery details stay editable until the order ships; items,
 * quantities and the delivery charge change through a quote-backed amendment
 * only on an unpaid, unshipped cash-on-delivery order with no discount code,
 * so its tax and line snapshots stay truthful (ORD-03).
 */
export function buildOrderEditReadiness(order: OrderEditSource): OrderEditReadiness {
    const detailsLock: OrderEditLockReason | null = order.archivedAt != null
        ? "archived"
        : SENT_ORDER_STATUSES.has(order.status)
            ? "shipped"
            : !OPEN_ORDER_STATUSES.has(order.status)
                ? "closed"
                : order.fulfillmentStatus !== FulfillmentStatus.PENDING
                    || Boolean(order.hasShipmentHistory)
                    || Boolean(order.hasNonPendingItem)
                    ? "shipped"
                    : order.shipmentClaimId
                        ? "busy"
                        : null;
    const itemsLock: OrderEditLockReason | null = detailsLock
        ?? (order.paymentMethod !== PaymentMethod.COD
            ? "online_payment"
            : order.paymentStatus !== PaymentStatus.UNPAID
                || order.paidAmountMinor !== 0
                || Boolean(order.hasPaymentHistory)
                || Boolean(order.hasPaymentSessionHistory)
                || Boolean(order.hasPaymentPlan)
                || !order.hasCleanCodTracking
                ? "paid"
                : Boolean(order.hasRefundHistory)
                    || Boolean(order.hasReturnHistory)
                    || Boolean(order.hasInvoiceHistory)
                    || !order.hasTaxSnapshot
                    ? "history"
                    : order.hasPromotionAllocation
                        ? "discount"
                        : order.inventoryAction !== "reserved" && order.inventoryAction !== "none"
                            ? "inventory"
                            : null);
    return { items: editState(itemsLock), details: editState(detailsLock) };
}

// Drizzle renders `${orders.id}` unqualified in a single-table select, and an
// unqualified `id` inside these EXISTS subqueries binds to the subquery table's
// own id column. Qualify the outer order explicitly.
const OUTER_ORDER_ID = sql.raw('"orders"."id"');

function orderEditEvidenceSelection() {
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
            sql`${orderItems.fulfillmentStatus} <> ${ItemFulfillmentStatus.PENDING}`,
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

const ORDER_EDIT_EVIDENCE_KEYS = [
    "inventoryAction",
    "shipmentClaimId",
    "hasTaxSnapshot",
    "hasPaymentHistory",
    "hasPaymentSessionHistory",
    "hasShipmentHistory",
    "hasRefundHistory",
    "hasReturnHistory",
    "hasInvoiceHistory",
    "hasPaymentPlan",
    "hasPromotionAllocation",
    "hasNonPendingItem",
    "hasCleanCodTracking",
] as const;
type OrderEditEvidenceKey = (typeof ORDER_EDIT_EVIDENCE_KEYS)[number];

function omitOrderEditEvidence<T extends Record<OrderEditEvidenceKey, unknown>>(
    order: T,
): Omit<T, OrderEditEvidenceKey> {
    const publicOrder: Record<string, unknown> = { ...order };
    for (const key of ORDER_EDIT_EVIDENCE_KEYS) delete publicOrder[key];
    return publicOrder as Omit<T, OrderEditEvidenceKey>;
}

export async function getOrderEditReadiness(
    db: Database,
    orderId: string,
): Promise<OrderEditReadiness | null> {
    const order = await db.select({ status: orders.status, ...orderEditEvidenceSelection() })
        .from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .get();
    return order ? buildOrderEditReadiness(order) : null;
}

const EDIT_LOCK_MESSAGES: Record<OrderEditLockReason, string> = {
    shipped: "This order has been sent, so it can't be changed.",
    closed: "This order is closed, so it can't be changed.",
    archived: "Unarchive this order to change it.",
    busy: "A courier booking is in progress. Try again in a minute.",
    online_payment: "Items on an online-paid order can't be changed. Refund or create a new order instead.",
    paid: "Items can't be changed after payment. Refund or create a new order instead.",
    history: "Items can't be changed after a refund, return or invoice. Create a new order instead.",
    discount: "This order used a discount, so its items can't be changed. You can still edit the customer and address.",
    inventory: "Stock for this order needs attention before its items can change.",
    unavailable: "A product on this order is no longer sold, so its items can't be changed. You can still edit the customer and address.",
};

export function orderEditLockMessage(reason: OrderEditLockReason | null): string {
    return reason ? EDIT_LOCK_MESSAGES[reason] : "This order can't be changed.";
}

type OrderListSort = "relevance" | "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
type OrderListPaymentAttemptRow = {
    orderId: string;
    gateway: string;
    paymentType: string;
    status: string;
    attempts: number;
    claimExpiresAt: number | null;
    createdAt: number;
    updatedAt: number;
};
type OrderListItemCountRow = {
    orderId: string;
    count: number;
    totalQuantity: number;
};
type OrderListShipmentRow = {
    orderId: string;
    id: string;
    providerId: string | null;
    providerType: string | null;
    status: string;
    rawStatus: string | null;
    externalId: string | null;
    trackingId: string | null;
    lastChecked: Date | null;
    updatedAt: Date | null;
    createdAt: Date | null;
    providerName: string | null;
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
type AdminOrderSkuItem = { productId: string; variantId: string | null };
type AdminOrderItemWithInventory<T extends AdminOrderSkuItem> = T & {
    variantId: string;
    inventoryTracked: boolean;
    productName: string;
    variantLabel: string | null;
    productImageMediaId: string | null;
    taxClassId: string | null;
    catalogUnitPriceMinor: number;
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
    unitPriceMinor: number;
}

/** Order totals in integer minor units: total = subtotal + shipping − discount. */
function calculateManualOrderMoney(
    items: ManualOrderMoneyItem[],
    shippingMinor: number,
    discountMinor: number,
    currency: OrderCurrencySnapshot,
) {
    const subtotalAmountMinor = items.reduce(
        (sum, item) => sum + item.unitPriceMinor * item.quantity,
        0,
    );
    if (discountMinor > subtotalAmountMinor) {
        throw new ValidationError(
            "Discount amount cannot exceed the manual order subtotal.",
            {
                reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
                maximumDiscountAmountMinor: subtotalAmountMinor,
                currencyCode: currency.code,
                decimalPlaces: currency.decimalPlaces,
            },
        );
    }
    return {
        subtotalAmountMinor,
        shippingAmountMinor: shippingMinor,
        discountAmountMinor: discountMinor,
        totalAmountMinor: subtotalAmountMinor + shippingMinor - discountMinor,
    };
}

export interface ManualOrderQuote {
    currencyCode: string;
    decimalPlaces: number;
    subtotalAmount: number;
    shippingAmount: number;
    discountAmount: number;
    taxAmount: number;
    totalAmount: number;
    taxLabel: string;
    pricesIncludeTax: boolean;
    taxEnabled: boolean;
    settingsVersion: number;
    lines: Array<{
        index: number;
        productId: string;
        variantId: string;
        quantity: number;
        unitPrice: number;
        lineSubtotal: number;
    }>;
}

interface PreparedManualOrderQuote {
    currency: OrderCurrencySnapshot;
    locationNames: {
        cityName: string;
        zoneName: string;
        areaName: string | null;
    };
    trackedItems: Array<AdminOrderItemWithInventory<ManualOrderMoneyItem>>;
    allocationLineIds: string[];
    taxQuote: TaxQuote;
    quote: ManualOrderQuote;
}

function projectManualOrderQuote(
    taxQuote: TaxQuote,
    trackedItems: PreparedManualOrderQuote["trackedItems"],
): ManualOrderQuote {
    const amount = (value: number) => fromMinor(value, taxQuote.decimalPlaces);
    return {
        currencyCode: taxQuote.currencyCode,
        decimalPlaces: taxQuote.decimalPlaces,
        subtotalAmount: amount(taxQuote.subtotalMinor),
        shippingAmount: amount(taxQuote.shippingMinor),
        discountAmount: amount(taxQuote.discountMinor),
        taxAmount: amount(taxQuote.taxMinor),
        totalAmount: amount(taxQuote.totalMinor),
        taxLabel: taxQuote.displayLabel,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        taxEnabled: taxQuote.enabled,
        settingsVersion: taxQuote.settingsVersion,
        lines: trackedItems.map((item, index) => ({
            index,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: amount(item.unitPriceMinor),
            lineSubtotal: amount(taxQuote.lines[index]?.grossAmountMinor ?? 0),
        })),
    };
}

async function prepareManualOrderQuote(
    db: Database,
    data: QuoteManualOrderInput,
    currencyOverride?: OrderCurrencySnapshot,
    retainedLines?: ReadonlyMap<string, { variantId: string | null; unitPriceMinor: number }>,
): Promise<PreparedManualOrderQuote> {
    const currency = currencyOverride ?? createOrderCurrencySnapshot(
        (await getCurrencySettings(db)).currencyCode,
    );
    // Keep location validation first so a stale/cross-parent destination fails
    // before catalog or tax reads do unnecessary work.
    const locationNames = await resolveActiveDeliveryLocationNames(db, data);
    const resolvedItems = await resolveAdminOrderItemInventory(db, data.items);
    const trackedItems = resolvedItems.map((item, index) => {
        const orderItemId = (data.items[index] as { orderItemId?: string | null } | undefined)?.orderItemId;
        const retained = orderItemId ? retainedLines?.get(orderItemId) : undefined;
        return {
            ...item,
            unitPriceMinor: retained && retained.variantId === item.variantId
                ? retained.unitPriceMinor
                : item.catalogUnitPriceMinor,
        };
    });
    const money = calculateManualOrderMoney(
        trackedItems,
        toMinor(data.shippingCharge, currency.decimalPlaces),
        toMinor(data.discountAmount ?? 0, currency.decimalPlaces),
        currency,
    );
    const allocationLineIds = trackedItems.map((item, index) =>
        buildStorefrontTaxAllocationLineId(index, item.variantId),
    );
    const taxQuote = await calculateStorefrontTaxQuote(db, {
        destination: {
            city: data.city,
            zone: data.zone,
            area: data.area,
            ...locationNames,
        },
        lines: trackedItems.map((item, index) => ({
            lineId: allocationLineIds[index]!,
            productId: item.productId,
            variantId: item.variantId,
            unitPriceMinor: item.unitPriceMinor,
            quantity: item.quantity,
            taxClassId: item.taxClassId,
        })),
        shippingMinor: money.shippingAmountMinor,
        discountMinor: money.discountAmountMinor,
        currency: {
            code: currency.code,
            decimalPlaces: currency.decimalPlaces,
        },
    });

    return {
        currency,
        locationNames,
        trackedItems,
        allocationLineIds,
        taxQuote,
        quote: projectManualOrderQuote(taxQuote, trackedItems),
    };
}

export async function quoteManualOrder(
    db: Database,
    data: QuoteManualOrderInput,
): Promise<ManualOrderQuote> {
    return (await prepareManualOrderQuote(db, data)).quote;
}
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

interface AdminOrderSkuIssue {
    index: number;
    productId: string;
    variantId: string | null;
    code: AdminOrderSkuIssueCode;
    message: string;
}

const HOSTED_PAYMENT_METHODS = listPaymentGateways().map((gateway) => gateway.id);

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
    canRepair: false,
    unknownOutcome: false,
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

function isHostedPaymentMethod(method: string | null | undefined): method is string {
    return isOnlinePaymentMethod(method);
}

function isBuyerRecoveryPaymentMethod(method: string | null | undefined): method is BuyerRecoveryPaymentMethod {
    return getPaymentGateway(method)?.flow === "hosted";
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

const SETTLED_PAYMENT_STATUSES = [
    PaymentStatus.PAID,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
] as const;

function paymentRecoveryLifecycleCondition() {
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

function paymentRecoveryFilterCondition(filter: OrderPaymentRecoveryFilter) {
    const orderIdSql = sql`${orders.id}`;
    const activeAttempt = activePaymentSessionAttemptExistsCondition(orderIdSql);
    const staleOrFailedAttempt = staleOrFailedPaymentSessionAttemptExistsCondition(orderIdSql);
    const hostedMethod = inArray(orders.paymentMethod, [...HOSTED_PAYMENT_METHODS]);
    const needsAttention = sql`(
        ${hostedMethod}
        AND ${paymentRecoveryLifecycleCondition()} = 1
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

    if (latestShipment?.rawStatus === PROVIDER_OUTCOME_UNKNOWN) {
        return {
            state: "needs_attention",
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
            canRepair: false,
            unknownOutcome: false,
            updatedAt: latestShipment?.updatedAt ?? null,
        };
    }

    return { ...DEFAULT_SHIPMENT_RECOVERY_SUMMARY };
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
            productDiscountType: products.discountType,
            productDiscountBps: products.discountBps,
            productDiscountAmountMinor: products.discountAmountMinor,
            storeCurrencyCode: storeCurrencyCodeSql(),
            variantPriceMinor: productVariants.priceMinor,
            variantDiscountType: productVariants.discountType,
            variantDiscountBps: productVariants.discountBps,
            variantDiscountAmountMinor: productVariants.discountAmountMinor,
            taxClassId: sql<string | null>`coalesce(${productVariants.taxClassId}, ${products.taxClassId})`,
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

        const variantHasDiscount =
            (sku.variantDiscountType === "percentage" && sku.variantDiscountBps > 0)
            || (sku.variantDiscountType === "flat" && sku.variantDiscountAmountMinor > 0);
        const catalogUnitPriceMinor = variantHasDiscount
            ? discountedPriceMinor(
                sku.variantPriceMinor,
                sku.variantDiscountType,
                sku.variantDiscountBps,
                sku.variantDiscountAmountMinor,
                storeCurrencyFromCode(sku.storeCurrencyCode),
            )
            : discountedPriceMinor(
                sku.variantPriceMinor,
                sku.productDiscountType,
                sku.productDiscountBps,
                sku.productDiscountAmountMinor,
                storeCurrencyFromCode(sku.storeCurrencyCode),
            );

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
            taxClassId: sku.taxClassId,
            catalogUnitPriceMinor,
        });
    });

    if (issues.length > 0) {
        throwAdminOrderSkuIssues(issues);
    }

    return resolvedItems;
}

export const ORDER_LIST_VIEWS = [
    "unfulfilled",
    "unpaid",
    "cod_to_collect",
    "delivery_failed",
    "returned",
] as const;
export type OrderListView = (typeof ORDER_LIST_VIEWS)[number];

function codTrackingStatusExists(statuses: readonly string[]): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${codTracking}
        WHERE ${codTracking.orderId} = ${orders.id}
          AND ${inArray(codTracking.codStatus, [...statuses])}
    )`;
}

function openCustomerRequestExists(): SQL {
    return sql`EXISTS (
        SELECT 1 FROM ${orderSupportRequests}
        WHERE ${orderSupportRequests.orderId} = ${orders.id}
          AND ${orderSupportRequests.activeKey} IS NOT NULL
    )`;
}

/**
 * The order tabs. Each view means money or work the merchant still has, so
 * cancelled, returned and unfinished online checkouts never sit in Unpaid or
 * Unfulfilled (ORD-09); cash on delivery gets its own views (ORD-29).
 */
function orderListViewCondition(view: OrderListView): SQL {
    switch (view) {
        case "unfulfilled":
            return sql`${inArray(orders.status, [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.CONFIRMED])}
                AND ${orders.fulfillmentStatus} <> ${FulfillmentStatus.COMPLETE}`;
        case "unpaid":
            return sql`${inArray(orders.paymentStatus, [PaymentStatus.UNPAID, PaymentStatus.PARTIAL])}
                AND ${notInArray(orders.status, [
                    OrderStatus.CANCELLED,
                    OrderStatus.RETURNED,
                    OrderStatus.REFUNDED,
                    OrderStatus.INCOMPLETE,
                ])}`;
        case "cod_to_collect":
            return sql`${orders.paymentMethod} = ${PaymentMethod.COD}
                AND ${inArray(orders.status, [OrderStatus.SHIPPED, OrderStatus.DELIVERED])}
                AND ${orders.balanceDueMinor} > 0
                AND ${codTrackingStatusExists([CodStatus.PENDING, CodStatus.FAILED])}`;
        case "delivery_failed":
            return sql`${orders.status} = ${OrderStatus.SHIPPED}
                AND ${codTrackingStatusExists([CodStatus.FAILED])}`;
        case "returned":
            return sql`${orders.status} = ${OrderStatus.RETURNED}`;
    }
}

interface OrderListFactsRow {
    orderNumber: number | null;
    archivedAt: Date | null;
    openRequestType: string | null;
    codStatus: string | null;
    codDeliveryAttempts: number | null;
    returnedValueMinor: number;
    refundedMinor: number;
}

/**
 * Per-order facts the list and detail both show: the open customer request,
 * the cash-on-delivery state, and the value of received returns versus what
 * was already refunded (the "refund owed" amount, ORD-05).
 */
function orderListFactsSelection() {
    const outerOrderId = sql`${orders.id}`;
    return {
        orderNumber: orders.orderNumber,
        archivedAt: orders.archivedAt,
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

function presentOrderListFacts(order: OrderListFactsRow & {
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
    };
}

function normalizeListPositiveInteger(value: number | undefined, fallback: number, max?: number): number {
    if (!Number.isFinite(value)) return fallback;
    const integer = Math.trunc(value as number);
    const minBounded = Math.max(1, integer);
    return max == null ? minBounded : Math.min(minBounded, max);
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
    view?: OrderListView;
    openRequest?: boolean;
    /** Exactly these orders (an export of a page or a selection). */
    ids?: string[];
    page?: number;
    limit?: number;
    showArchived?: boolean;
    sort?: OrderListSort;
    order?: "asc" | "desc";
    startDate?: Date;
    endDate?: Date;
}) {
    const {
        search,
        status,
        view,
        openRequest = false,
        ids,
        paymentStatus,
        paymentMethod,
        fulfillmentStatus,
        paymentRecovery,
        page: rawPage = 1,
        limit: rawLimit = 10,
        showArchived = false,
        sort = "createdAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const page = normalizeListPositiveInteger(rawPage, 1);
    const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT);
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [];

    whereConditions.push(sql`${orders.deletedAt} IS NULL`);
    if (ids) {
        // An explicit selection is exported as picked, archived or not.
        whereConditions.push(ids.length > 0 ? inArray(orders.id, ids) : sql`1 = 0`);
    } else {
        whereConditions.push(showArchived ? sql`${orders.archivedAt} IS NOT NULL` : sql`${orders.archivedAt} IS NULL`);
    }

    let rankExpression: SQL | undefined = undefined;
    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
        const phoneSearchTerms = buildPhoneSearchTerms(trimmedSearch);
        const phoneCondition = isLikelyPhoneSearch(trimmedSearch)
            ? buildPhoneSearchCondition(phoneSearchTerms)
            : undefined;
        const ftsCondition = ftsMatch(db, "orders_fts", "orders", trimmedSearch);
        // Merchants also look orders up by the courier's consignment or tracking id.
        const courierIdCondition = sql`EXISTS (
            SELECT 1 FROM ${deliveryShipments}
            WHERE ${deliveryShipments.orderId} = ${orders.id}
              AND (lower(${deliveryShipments.trackingId}) = lower(${trimmedSearch})
                OR lower(${deliveryShipments.externalId}) = lower(${trimmedSearch}))
        )`;
        const orderNumberCondition = orderNumberSearchCondition(trimmedSearch);
        const matches = [orderNumberCondition, ftsCondition, phoneCondition, courierIdCondition].filter(
            (condition): condition is SQL => condition !== undefined,
        );
        whereConditions.push(sql`(${sql.join(matches, sql` OR `)})`);
        const ftsRank = ftsCondition && isFts5SearchEnabled(db)
            ? sql`COALESCE(
                    (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitizeFtsQuery(trimmedSearch)}),
                    999999
                ) ASC`
            : undefined;
        // "#1001" puts that order first, then the best text matches.
        const numberRank = orderNumberCondition
            ? sql`CASE WHEN ${orderNumberCondition} THEN 0 ELSE 1 END ASC`
            : undefined;
        rankExpression = numberRank && ftsRank
            ? sql`${numberRank}, ${ftsRank}`
            : numberRank ?? ftsRank;
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    }

    if (view) {
        whereConditions.push(orderListViewCondition(view));
    }

    if (openRequest) {
        whereConditions.push(openCustomerRequestExists());
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
                    return orders.totalAmountMinor;
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
            ...orderMoneySelection(orders),
            currencyCode: orders.currencyCode,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            taxAmountMinor: orders.taxAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            fulfillmentStatus: orders.fulfillmentStatus,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            version: orders.version,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...orderListFactsSelection(),
        })
        .from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(...orderByExpressions);

    // Batch count + data in a single round-trip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const batchResult = await db.batch([countQuery, dataQuery] as any) as any;
    const countArr = batchResult[0] as { count: number }[];
    const results = batchResult[1] as ({
        id: string; customerName: string; customerPhone: string; customerEmail: string | null;
        customerId: string | null;
        currencyDecimalPlaces: number; totalAmountMinor: number; shippingAmountMinor: number;
        discountAmountMinor: number; paidAmountMinor: number; balanceDueMinor: number;
        subtotalAmountMinor: number;
        status: string; paymentStatus: string; paymentMethod: string | null; fulfillmentStatus: string;
        createdAt: number; updatedAt: number; version: number;
        city: string | null; zone: string | null; area: string | null;
        cityName: string | null; zoneName: string | null; areaName: string | null;
        shipmentClaimId: string | null; shipmentClaimExpiresAt: Date | number | string | null;
        paymentRecoveryApplicable: number;
    } & OrderListFactsRow)[];
    const count = countArr[0]?.count ?? 0;

    const orderIds = results.map((r) => r.id);

    const enrichmentResults = await safeBatch(db, [
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
            }).from(paymentSessionAttempts).where(sql`1=0`),
        selectActiveRefundAttemptRowsForOrders(db, orderIds),
    ]);
    const itemCounts = enrichmentResults[0] as OrderListItemCountRow[];
    const shipments = enrichmentResults[1] as OrderListShipmentRow[];
    const paymentAttempts = enrichmentResults[2] as OrderListPaymentAttemptRow[];
    const activeRefundAttemptRows = enrichmentResults[3] as RefundAttemptVisibilityRow[];
    const activeRefundOperations = resolveActiveRefundOperationsForOrders(
        activeRefundAttemptRows,
    );

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
    for (const attempt of paymentAttempts) {
        if (!attempt.orderId) continue;
        const attempts = attemptsByOrderId.get(attempt.orderId) ?? [];
        attempts.push(attempt);
        attemptsByOrderId.set(attempt.orderId, attempts);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);

    const formattedResults = results.map((order) => {
        const latestShipment = shipmentMap.get(order.id) || null;
        const {
            paymentRecoveryApplicable: _paymentRecoveryApplicable,
            codStatus: _codStatus,
            codDeliveryAttempts: _codDeliveryAttempts,
            returnedValueMinor: _returnedValueMinor,
            refundedMinor: _refundedMinor,
            ...publicOrder
        } = order;
        return {
            ...publicOrder,
            ...orderMoneyAmounts(order),
            ...presentOrderListFacts(order),
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

/** Address, note and line items for an export page (at most 90 orders per read). */
export async function loadOrderExportDetails(db: Database, orderIds: readonly string[]) {
    const details = new Map<string, {
        shippingAddress: string;
        notes: string | null;
        lines: Array<{
            productName: string | null;
            variantLabel: string | null;
            quantity: number;
            unitPrice: number;
            lineTotal: number;
        }>;
    }>();
    for (const chunk of chunkIds(orderIds)) {
        const [orderRows, itemRows] = await Promise.all([
            db.select({
                id: orders.id,
                shippingAddress: orders.shippingAddress,
                notes: orders.notes,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
            }).from(orders).where(inArray(orders.id, chunk)).all(),
            db.select({
                orderId: orderItems.orderId,
                productName: orderItems.productName,
                variantLabel: orderItems.variantLabel,
                quantity: orderItems.quantity,
                unitPriceMinor: orderItems.unitPriceMinor,
                lineSubtotalMinor: orderItems.lineSubtotalMinor,
            }).from(orderItems).where(inArray(orderItems.orderId, chunk)).orderBy(orderItems.createdAt, orderItems.id).all(),
        ]);
        const places = new Map(orderRows.map((row) => [row.id, row.currencyDecimalPlaces]));
        for (const row of orderRows) {
            details.set(row.id, { shippingAddress: row.shippingAddress, notes: row.notes, lines: [] });
        }
        for (const item of itemRows) {
            const decimals = places.get(item.orderId) ?? 2;
            details.get(item.orderId)?.lines.push({
                productName: item.productName,
                variantLabel: item.variantLabel,
                quantity: item.quantity,
                unitPrice: fromMinor(item.unitPriceMinor, decimals),
                lineTotal: fromMinor(item.lineSubtotalMinor, decimals),
            });
        }
    }
    return details;
}

function chunkIds(ids: readonly string[]): string[][] {
    const chunks: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += 90) chunks.push(ids.slice(offset, offset + 90));
    return chunks;
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

/**
 * Returns full order details including all items and variant info.
 * Returns null if the order does not exist.
 */
export async function getOrderDetails(
    db: Database,
    id: string,
): Promise<OrderDetails | null> {
    return retryTransientD1(() => getOrderDetailsOnce(db, id));
}

async function getOrderDetailsOnce(
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
            ...orderMoneySelection(orders),
            currencyCode: orders.currencyCode,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingMethodId: orders.shippingMethodId,
            shippingMethodName: orders.shippingMethodName,
            shippingMethodDescription: orders.shippingMethodDescription,
            shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
            shippingFeeWaived: orders.shippingFeeWaived,
            taxAmountMinor: orders.taxAmountMinor,
            taxLabel: orders.taxLabel,
            pricesIncludeTax: orders.pricesIncludeTax,
            status: orders.status,
            notes: orders.notes,
            shippingAddress: orders.shippingAddress,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            version: orders.version,
            createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${orders.deletedAt} AS INTEGER)`,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...orderEditEvidenceSelection(),
            ...orderListFactsSelection(),
        })
        .from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(eq(orders.id, id))
        .get();

    if (!order) return null;

    const [items, latestShipments, refundAttemptViews, supportRequests, promotionRows, paymentAttempts] = await Promise.all([
        db
            .select({
                id: orderItems.id,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                productName: orderItems.productName,
                productImageObjectKey: publishedMediaObjectKey(),
                productImageStatus: media.status,
                variantLabel: orderItems.variantLabel,
                fulfillmentStatus: orderItems.fulfillmentStatus,
                shippedQuantity: orderItems.shippedQuantity,
                inventoryTracked: orderItems.inventoryTracked,
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
        db
            .select({
                promotionId: orderDiscountAllocations.promotionId,
                method: orderDiscountAllocations.method,
                name: orderDiscountAllocations.promotionName,
                code: orderDiscountAllocations.promotionCode,
                amountMinor: sql<number>`SUM(${orderDiscountAllocations.discountAmountMinor})`,
            })
            .from(orderDiscountAllocations)
            .where(eq(orderDiscountAllocations.orderId, id))
            .groupBy(
                orderDiscountAllocations.promotionId,
                orderDiscountAllocations.method,
                orderDiscountAllocations.promotionName,
                orderDiscountAllocations.promotionCode,
            )
            .orderBy(orderDiscountAllocations.promotionName),
        listOrderPaymentSessionAttempts(db, id),
    ]);

    const formattedItems = items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
        productName: item.productName || null,
        productImage:
            item.productImageObjectKey &&
            (item.productImageStatus === "ready" || item.productImageStatus === "trashed")
                ? getCurrentPublicMediaUrl(item.productImageObjectKey)
                : null,
        variantLabel: item.variantLabel || null,
        fulfillmentStatus: item.fulfillmentStatus,
        shippedQuantity: item.shippedQuantity,
        inventoryTracked: item.inventoryTracked,
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
    const {
        paymentRecoveryApplicable: _paymentRecoveryApplicable,
        codStatus: _codStatus,
        codDeliveryAttempts: _codDeliveryAttempts,
        returnedValueMinor: _returnedValueMinor,
        refundedMinor: _refundedMinor,
        ...publicOrder
    } = omitOrderEditEvidence(order);

    return {
        ...publicOrder,
        ...orderMoneyAmounts(order),
        ...presentOrderListFacts(order),
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        discounts: promotionRows.map((row) => ({
            promotionId: row.promotionId,
            name: row.name,
            code: row.code,
            method: row.method,
            amount: fromMinor(Number(row.amountMinor) || 0, order.currencyDecimalPlaces),
        })),
        items: formattedItems,
        itemCount: formattedItems.length,
        latestShipment,
        shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds),
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        supportRequests,
        paymentRecovery: buildPaymentRecoverySummary(order, paymentAttempts, nowSeconds),
        editReadiness: buildOrderEditReadiness(order),
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
 *   3. Commit one confirmed, unpaid COD order with immutable money/tax facts
 *   4. Keep tracked stock reserved until the fulfillment lifecycle deducts it
 *   5. If the batch fails, release all reservations (no orphaned holds)
 */
export async function createOrder(
    db: Database,
    data: CreateOrderInput,
    actorId: string | null,
): Promise<{ id: string }> {
    const attemptIdentity = await buildAdminOrderCreateAttemptIdentity(data, actorId);
    const existingReplay = await resolveAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (existingReplay) return existingReplay.response;
    await validateCustomerPhoneCountry(db, data.customerPhone);
    const claim = await claimAdminOrderCreateAttempt<{ id: string }>(db, attemptIdentity);
    if (claim.status === "replay") return claim.response;
    if (claim.status === "processing") {
        throw new ServiceUnavailableError(
            "This manual order is still being created. Retry the same form in a moment.",
        );
    }
    const attempt = claim.attempt;
    const orderId = attempt.orderId;
    const response = { id: orderId };

    // A committed response is resolved before mutable policy checks so a lost
    // response still replays. Fresh requests validate before claiming, which
    // lets a merchant correct a rejected phone without burning the request key.
    const prepared = await (async () => {
        const manualQuote = await prepareManualOrderQuote(db, data);
        const {
            locationNames: { cityName, zoneName, areaName },
            trackedItems,
            allocationLineIds,
            taxQuote,
            quote,
        } = manualQuote;
        const initialPaymentState = computeOrderPaymentState({
            totalAmountMinor: taxQuote.totalMinor,
            paidAmountMinor: 0,
        });
        const existingCustomer = await db
            .select()
            .from(customers)
            .where(eq(customers.phone, data.customerPhone))
            .get();
        const reservationEntries: ReservationEntry[] = trackedItems
            .filter((item) => item.inventoryTracked)
            .map((item) => ({
                variantId: item.variantId,
                quantity: item.quantity,
                pool: "regular" as const,
            }));
        const inventoryPlan = await prepareStockReservationBatch(
            db,
            reservationEntries.map((entry) => ({
                variantId: entry.variantId,
                quantity: entry.quantity,
                orderId,
            })),
            "regular",
            { reservationKey: `admin-order-create:v2:${orderId}` },
        );
        if (!inventoryPlan.success) {
            throw new ValidationError(
                inventoryPlan.error ?? "Insufficient stock for one or more items",
            );
        }

        return {
            initialPaymentState,
            cityName,
            zoneName,
            areaName,
            existingCustomer,
            trackedItems,
            allocationLineIds,
            taxQuote,
            quote,
            reservationEntries,
            inventoryPlan,
        };
    })().catch(async (error) => {
        await markAdminOrderCreateAttemptFailed(db, attempt, error).catch(() => undefined);
        throw error;
    });
    const {
        initialPaymentState,
        cityName,
        zoneName,
        areaName,
        existingCustomer,
        trackedItems,
        allocationLineIds,
        taxQuote,
        quote,
        reservationEntries,
        inventoryPlan,
    } = prepared;
    let customerId = existingCustomer?.id;

    // ── Atomic batch: customer + order + items ──────────────────────────
    // D1 batch() executes all statements in a single atomic operation.
    // If any statement fails, none are committed.
    const writeBatch: SQLiteBatchItem[] = [
        buildAdminOrderCreateAttemptGuard(db, attempt),
        ...inventoryPlan.statements,
    ];

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
                totalOrders: sql`${customers.totalOrders} + 1`,
                lastOrderAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }).where(eq(customers.id, existingCustomer.id)),
        );
    }

    const preparedOrderItems = trackedItems.map((item, index) => {
        const allocationLineId = allocationLineIds[index]!;
        const lineTax = taxQuote.lines.find((line) => line.lineId === allocationLineId);
        if (!lineTax) {
            throw new ValidationError("Authoritative tax quote is missing a manual-order line. Please retry.");
        }
        return {
            id: generateOrderId(),
            item,
            lineTax,
        };
    });

    // Order row
    writeBatch.push(
        db.insert(orders).values({
            orderNumber: nextOrderNumberSql(),
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
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            paidAmountMinor: initialPaymentState.paidAmountMinor,
            balanceDueMinor: initialPaymentState.balanceDueMinor,
            paymentStatus: initialPaymentState.paymentStatus,
            paymentMethod: PaymentMethod.COD,
            fulfillmentStatus: FulfillmentStatus.PENDING,
            status: OrderStatus.CONFIRMED,
            customerId,
            inventoryAction: reservationEntries.length > 0 ? "reserved" : "none",
            version: 1,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }),
    );

    // A COD order and its collection lifecycle are one durable fact. Keeping
    // this inside the create batch prevents a shippable order whose cash can
    // never be recorded because a later initialization call failed.
    writeBatch.push(
        db.insert(codTracking).values(createCODTrackingInsertValues(orderId)),
    );

    // Order items
    if (preparedOrderItems.length > 0) {
        const itemRows = preparedOrderItems.map(({ id, item, lineTax }) => ({
            id,
            orderId,
            productId: item.productId,
            variantId: item.variantId,
            productImageMediaId: item.productImageMediaId,
            quantity: item.quantity,
            productName: item.productName,
            variantLabel: item.variantLabel,
            inventoryTracked: item.inventoryTracked,
            unitPriceMinor: lineTax.unitPriceMinor,
            lineSubtotalMinor: lineTax.grossAmountMinor,
            discountAmountMinor: lineTax.discountMinor,
            taxableAmountMinor: lineTax.taxableAmountMinor,
            taxAmountMinor: lineTax.taxMinor,
            fulfillmentStatus: ItemFulfillmentStatus.PENDING,
            createdAt: sql`unixepoch()`,
        }));
        for (const chunk of chunkRowsForD1(
            itemRows,
            ORDER_ITEM_INSERT_PARAMETERS_PER_ROW,
        )) {
            writeBatch.push(db.insert(orderItems).values(chunk));
        }

        const itemTaxRows = preparedOrderItems.map(({ id, lineTax }) => ({
            orderItemId: id,
            orderId,
            taxClassId: lineTax.taxClassId,
            taxClassName: lineTax.taxClassName,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            rateSnapshot: JSON.stringify(lineTax.components),
            createdAt: sql`unixepoch()`,
        }));
        for (const chunk of chunkRowsForD1(
            itemTaxRows,
            ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW,
        )) {
            writeBatch.push(db.insert(orderItemTaxSnapshots).values(chunk));
        }
    }

    writeBatch.push(
        db.insert(orderTaxSnapshots).values({
            orderId,
            currencyCode: taxQuote.currencyCode,
            decimalPlaces: taxQuote.decimalPlaces,
            displayLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            shippingTaxed: taxQuote.shippingTaxed,
            settingsVersion: taxQuote.settingsVersion,
            calculationVersion: taxQuote.calculationVersion,
            destinationSnapshot: JSON.stringify(taxQuote.destination),
            rateSnapshot: JSON.stringify({
                lines: taxQuote.lines.map((line) => ({
                    lineId: line.lineId,
                    taxClassId: line.taxClassId,
                    taxClassName: line.taxClassName,
                    components: line.components,
                })),
                shipping: taxQuote.shipping,
            }),
            createdAt: sql`unixepoch()`,
        }),
    );

    writeBatch.push(buildAdminOrderCreateAttemptCommit(db, attempt, response));

    try {
        await safeBatch(db, writeBatch);
    } catch (batchError) {
        const replay = await resolveAdminOrderCreateAttempt<{ id: string }>(
            db,
            attemptIdentity,
        ).catch(() => null);
        if (replay) return replay.response;
        if (isAdminOrderCreateAttemptGuardError(batchError)) {
            // A reclaimed request owns the same stable reservation identity.
            // Do not release stock underneath the new owner.
            throw new ConflictError(
                "Another request owns this manual-order creation. Retry the same form to recover its result.",
            );
        }

        // Inventory guards, ledger edges, counters, customer/order facts, COD,
        // tax snapshots, and idempotency evidence share this one transaction.
        // A failed batch has no reservation to compensate.
        await markAdminOrderCreateAttemptFailed(db, attempt, batchError).catch(() => undefined);
        throw batchError;
    }

    return response;
}

export interface ManualOrderAmendmentPreview extends ManualOrderQuote {
    orderId: string;
    expectedVersion: number;
    resultingVersion: number;
    balanceDue: number;
    quoteFingerprint: string;
}

export interface ManualOrderAmendmentResult {
    id: string;
    version: number;
    totalAmount: number;
    balanceDue: number;
    inventoryMutationVariantIds: string[];
}

function normalizeAmendmentRequest(
    orderId: string,
    data: PreviewManualOrderAmendmentInput & { quoteFingerprint?: string },
): Record<string, unknown> {
    return {
        version: 1,
        orderId,
        expectedVersion: data.expectedVersion,
        customerName: data.customerName.trim(),
        customerPhone: data.customerPhone.trim(),
        customerEmail: data.customerEmail?.trim().toLowerCase() ?? null,
        shippingAddress: data.shippingAddress.trim(),
        city: data.city,
        zone: data.zone,
        area: data.area,
        notes: data.notes,
        items: data.items.map((item) => ({
            orderItemId: item.orderItemId ?? null,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
        })),
        shippingCharge: data.shippingCharge,
        discountAmount: data.discountAmount,
        quoteFingerprint: data.quoteFingerprint ?? null,
    };
}

async function buildManualOrderAmendmentQuoteFingerprint(
    taxQuote: TaxQuote,
): Promise<string> {
    return sha256Hex(stableStringify({
        version: 1,
        calculationVersion: taxQuote.calculationVersion,
        enabled: taxQuote.enabled,
        currencyCode: taxQuote.currencyCode,
        decimalPlaces: taxQuote.decimalPlaces,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        shippingTaxed: taxQuote.shippingTaxed,
        settingsVersion: taxQuote.settingsVersion,
        subtotalMinor: taxQuote.subtotalMinor,
        shippingMinor: taxQuote.shippingMinor,
        discountMinor: taxQuote.discountMinor,
        taxableMinor: taxQuote.taxableMinor,
        taxMinor: taxQuote.taxMinor,
        totalMinor: taxQuote.totalMinor,
        lines: taxQuote.lines,
        shipping: taxQuote.shipping,
    }));
}

async function requireAmendableOrder(
    db: Database,
    orderId: string,
    expectedVersion: number,
) {
    const order = await db.select().from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt), isNull(orders.archivedAt)))
        .get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.version !== expectedVersion) {
        throw new ConflictError(
            "This order changed after you opened it. Reload and review the latest values.",
        );
    }
    const readiness = await getOrderEditReadiness(db, orderId);
    if (!readiness?.items.allowed) {
        throw new ConflictError(orderEditLockMessage(readiness?.items.reason ?? null));
    }
    return order;
}

/**
 * Lines the merchant keeps on an amended order keep the price the customer
 * agreed to; only newly added lines take today's catalog price.
 */
async function loadRetainedUnitPrices(db: Database, orderId: string) {
    const rows = await db.select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        unitPriceMinor: orderItems.unitPriceMinor,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    return new Map(rows.map((row) => [row.id, row]));
}

export async function previewManualOrderAmendment(
    db: Database,
    orderId: string,
    data: PreviewManualOrderAmendmentInput,
): Promise<ManualOrderAmendmentPreview> {
    const order = await requireAmendableOrder(db, orderId, data.expectedVersion);
    if (data.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, data.customerPhone);
    }
    const prepared = await prepareManualOrderQuote(
        db,
        data,
        resolveOrderCurrencySnapshot(order),
        await loadRetainedUnitPrices(db, orderId),
    );
    const quoteFingerprint = await buildManualOrderAmendmentQuoteFingerprint(prepared.taxQuote);
    return {
        ...prepared.quote,
        orderId,
        expectedVersion: data.expectedVersion,
        resultingVersion: data.expectedVersion + 1,
        balanceDue: prepared.quote.totalAmount,
        quoteFingerprint,
    };
}

function amendmentCommitGuard(orderId: string, expectedVersion: number) {
    return sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId}
          AND ${orders.version} = ${expectedVersion}
          AND ${orders.deletedAt} IS NULL
          AND ${orders.archivedAt} IS NULL
          AND ${orders.paymentMethod} = ${PaymentMethod.COD}
          AND ${orders.paymentStatus} = ${PaymentStatus.UNPAID}
          AND ${orders.paidAmountMinor} = 0
          AND ${orders.fulfillmentStatus} = ${FulfillmentStatus.PENDING}
          AND ${orders.status} IN (${OrderStatus.PENDING}, ${OrderStatus.PROCESSING}, ${OrderStatus.CONFIRMED})
          AND ${orders.shipmentClaimId} IS NULL
          AND ${orders.inventoryAction} IN ('reserved', 'none')
          AND EXISTS (
            SELECT 1 FROM ${orderTaxSnapshots}
            WHERE ${orderTaxSnapshots.orderId} = ${orderId}
          )
          AND EXISTS (
            SELECT 1 FROM ${codTracking}
            WHERE ${codTracking.orderId} = ${orderId}
              AND ${codTracking.codStatus} = 'pending'
              AND ${codTracking.collectedAt} IS NULL
              AND COALESCE(${codTracking.collectedAmountMinor}, 0) = 0
          )
          AND NOT EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${paymentSessionAttempts} WHERE ${paymentSessionAttempts.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${paymentPlans} WHERE ${paymentPlans.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${refundAttempts} WHERE ${refundAttempts.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${orderReturns} WHERE ${orderReturns.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${orderInvoices} WHERE ${orderInvoices.orderId} = ${orderId})
          AND NOT EXISTS (SELECT 1 FROM ${orderDiscountAllocations} WHERE ${orderDiscountAllocations.orderId} = ${orderId})
          AND NOT EXISTS (
            SELECT 1 FROM ${orderItems}
            WHERE ${orderItems.orderId} = ${orderId}
              AND ${orderItems.fulfillmentStatus} <> ${ItemFulfillmentStatus.PENDING}
          )
    )`;
}

async function resolveManualOrderAmendmentReplay(
    db: Database,
    keyHash: string,
    requestHash: string,
): Promise<ManualOrderAmendmentResult | null> {
    const row = await db.select({
        requestHash: orderAmendments.requestHash,
        responsePayload: orderAmendments.responsePayload,
    }).from(orderAmendments)
        .where(eq(orderAmendments.idempotencyKeyHash, keyHash))
        .get();
    if (!row) return null;
    if (row.requestHash !== requestHash) {
        throw new ConflictError("This amendment request key was already used for different changes.");
    }
    try {
        return JSON.parse(row.responsePayload) as ManualOrderAmendmentResult;
    } catch {
        throw new ServiceUnavailableError(
            "The confirmed amendment response is unavailable. Reload the order before retrying.",
        );
    }
}

export async function confirmManualOrderAmendment(
    db: Database,
    orderId: string,
    data: ConfirmManualOrderAmendmentInput,
    actorId: string | null,
): Promise<ManualOrderAmendmentResult> {
    const actorScope = actorId ?? "unknown-admin";
    const keyHash = await sha256Hex(`${actorScope}:${data.requestKey.trim()}`);
    const requestHash = await sha256Hex(stableStringify(
        normalizeAmendmentRequest(orderId, data),
    ));
    const replay = await resolveManualOrderAmendmentReplay(db, keyHash, requestHash);
    if (replay) return replay;

    const order = await requireAmendableOrder(db, orderId, data.expectedVersion);
    if (data.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, data.customerPhone);
    }
    const prepared = await prepareManualOrderQuote(
        db,
        data,
        resolveOrderCurrencySnapshot(order),
        await loadRetainedUnitPrices(db, orderId),
    );
    const currentQuoteFingerprint =await buildManualOrderAmendmentQuoteFingerprint(prepared.taxQuote);
    if (currentQuoteFingerprint !== data.quoteFingerprint) {
        throw new ConflictError(
            "Prices or taxes changed after preview. Refresh the quote and review the updated COD total.",
        );
    }
    const existingItems = await db.select().from(orderItems)
        .where(eq(orderItems.orderId, orderId));
    const existingTaxSnapshot = await db.select().from(orderTaxSnapshots)
        .where(eq(orderTaxSnapshots.orderId, orderId)).get();
    const existingItemTaxSnapshots = await db.select().from(orderItemTaxSnapshots)
        .where(eq(orderItemTaxSnapshots.orderId, orderId));
    if (!existingTaxSnapshot) throw new ConflictError("The order tax snapshot is unavailable.");
    if (
        existingItemTaxSnapshots.length !== existingItems.length
        || existingItems.some((item) => !existingItemTaxSnapshots.some(
            (snapshot) => snapshot.orderItemId === item.id,
        ))
    ) {
        throw new ConflictError("An order line tax snapshot is unavailable.");
    }

    const existingById = new Map(existingItems.map((item) => [item.id, item]));
    const retainedIds = new Set<string>();
    const preparedItems = prepared.trackedItems.map((item, index) => {
        const requested = data.items[index]!;
        const existing = requested.orderItemId
            ? existingById.get(requested.orderItemId)
            : undefined;
        if (requested.orderItemId && (
            !existing
            || existing.productId !== item.productId
            || existing.variantId !== item.variantId
            || retainedIds.has(requested.orderItemId)
        )) {
            throw new ConflictError("An amended line no longer matches the loaded order. Reload and review it.");
        }
        const id = existing?.id ?? `item_${nanoid()}`;
        retainedIds.add(id);
        const lineTax = prepared.taxQuote.lines.find(
            (line) => line.lineId === prepared.allocationLineIds[index],
        );
        if (!lineTax) throw new ValidationError("Authoritative tax quote is missing an amendment line.");
        return { id, item, lineTax, retained: Boolean(existing) };
    });

    const pool = (order.inventoryPool as NonNullable<ReservationEntry["pool"]>) ?? "regular";
    const oldEntries = buildInventoryEntries(existingItems, pool);
    const newEntries = buildInventoryEntries(prepared.trackedItems, pool);
    const { positiveEntries, negativeEntries } = computeInventoryDeltas(oldEntries, newEntries, pool);
    const inventoryKey = `order-amendment:v1:${keyHash}`;
    const reservePlan = await prepareStockReservationBatch(
        db,
        toReservationBatchItems(positiveEntries, orderId),
        pool,
        { reservationKey: inventoryKey },
    );
    if (!reservePlan.success) {
        throw new ValidationError(reservePlan.error ?? "Insufficient stock for this amendment.");
    }
    const releasePlan = await prepareReservedStockReleaseBatch(
        db,
        negativeEntries,
        orderId,
        { releaseKey: inventoryKey, requireExact: true },
    );
    if (!releasePlan.success) {
        throw new ConflictError(
            releasePlan.error ?? "The existing reservation must be reconciled before amending.",
        );
    }

    let customerId = order.customerId;
    let newCustomerId: string | null = null;
    if (data.customerPhone !== order.customerPhone || !customerId) {
        const existingCustomer = await db.select({ id: customers.id }).from(customers)
            .where(eq(customers.phone, data.customerPhone)).get();
        customerId = existingCustomer?.id ?? `cust_${nanoid()}`;
        if (!existingCustomer) newCustomerId = customerId;
    }

    const resultingVersion = data.expectedVersion + 1;
    const totalAmount = prepared.quote.totalAmount;
    const response: ManualOrderAmendmentResult = {
        id: orderId,
        version: resultingVersion,
        totalAmount,
        balanceDue: totalAmount,
        inventoryMutationVariantIds: [...new Set([
            ...positiveEntries.map((entry) => entry.variantId),
            ...negativeEntries.map((entry) => entry.variantId),
        ])],
    };
    const beforeSnapshot = JSON.stringify({
        order,
        items: existingItems,
        tax: existingTaxSnapshot,
        itemTaxes: existingItemTaxSnapshots,
    });
    const afterSnapshot = JSON.stringify({
        order: {
            ...normalizeAmendmentRequest(orderId, data),
            version: resultingVersion,
            currencyCode: prepared.taxQuote.currencyCode,
            currencyDecimalPlaces: prepared.taxQuote.decimalPlaces,
            subtotalAmountMinor: prepared.taxQuote.subtotalMinor,
            shippingAmountMinor: prepared.taxQuote.shippingMinor,
            discountAmountMinor: prepared.taxQuote.discountMinor,
            taxAmountMinor: prepared.taxQuote.taxMinor,
            totalAmountMinor: prepared.taxQuote.totalMinor,
            balanceDueMinor: prepared.taxQuote.totalMinor,
        },
        items: preparedItems.map(({ id, item, lineTax }) => ({ id, ...item, lineTax })),
    });

    const statements: SQLiteBatchItem[] = [
        buildBatchGuard(
            db,
            amendmentCommitGuard(orderId, data.expectedVersion),
            ORDER_AMENDMENT_GUARD_MARKER,
        ),
        ...reservePlan.statements,
        ...releasePlan.statements,
    ];
    if (newCustomerId) {
        statements.push(db.insert(customers).values({
            id: newCustomerId,
            name: data.customerName,
            email: data.customerEmail,
            phone: data.customerPhone,
            address: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName: prepared.locationNames.cityName,
            zoneName: prepared.locationNames.zoneName,
            areaName: prepared.locationNames.areaName,
            totalOrders: 1,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }));
        statements.push(db.insert(customerHistory).values({
            id: `hist_${nanoid()}`,
            customerId: newCustomerId,
            name: data.customerName,
            email: data.customerEmail,
            phone: data.customerPhone,
            address: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName: prepared.locationNames.cityName,
            zoneName: prepared.locationNames.zoneName,
            areaName: prepared.locationNames.areaName,
            changeType: "created",
            createdAt: sql`unixepoch()`,
        }));
    }
    statements.push(
        db.insert(orderAmendments).values({
            id: `oamd_${crypto.randomUUID()}`,
            orderId,
            actorId,
            idempotencyKeyHash: keyHash,
            requestHash,
            expectedVersion: data.expectedVersion,
            resultingVersion,
            beforeSnapshot,
            afterSnapshot,
            responsePayload: JSON.stringify(response),
            createdAt: sql`unixepoch()`,
        }),
        db.update(orders).set({
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail,
            shippingAddress: data.shippingAddress,
            city: data.city,
            zone: data.zone,
            area: data.area,
            cityName: prepared.locationNames.cityName,
            zoneName: prepared.locationNames.zoneName,
            areaName: prepared.locationNames.areaName,
            notes: data.notes,
            currencyCode: prepared.taxQuote.currencyCode,
            currencyDecimalPlaces: prepared.taxQuote.decimalPlaces,
            subtotalAmountMinor: prepared.taxQuote.subtotalMinor,
            shippingAmountMinor: prepared.taxQuote.shippingMinor,
            discountAmountMinor: prepared.taxQuote.discountMinor,
            taxAmountMinor: prepared.taxQuote.taxMinor,
            totalAmountMinor: prepared.taxQuote.totalMinor,
            taxLabel: prepared.taxQuote.displayLabel,
            pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
            paidAmountMinor: 0,
            balanceDueMinor: prepared.taxQuote.totalMinor,
            paymentStatus: PaymentStatus.UNPAID,
            customerId,
            inventoryAction: newEntries.length > 0 ? "reserved" : "none",
            version: resultingVersion,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, data.expectedVersion),
            amendmentCommitGuard(orderId, data.expectedVersion),
        )),
    );

    for (const preparedItem of preparedItems) {
        const itemValues = {
            productId: preparedItem.item.productId,
            variantId: preparedItem.item.variantId,
            productImageMediaId: preparedItem.item.productImageMediaId,
            quantity: preparedItem.item.quantity,
            productName: preparedItem.item.productName,
            variantLabel: preparedItem.item.variantLabel,
            inventoryTracked: preparedItem.item.inventoryTracked,
            unitPriceMinor: preparedItem.lineTax.unitPriceMinor,
            lineSubtotalMinor: preparedItem.lineTax.grossAmountMinor,
            discountAmountMinor: preparedItem.lineTax.discountMinor,
            taxableAmountMinor: preparedItem.lineTax.taxableAmountMinor,
            taxAmountMinor: preparedItem.lineTax.taxMinor,
            fulfillmentStatus: ItemFulfillmentStatus.PENDING,
        };
        if (preparedItem.retained) {
            statements.push(
                db.update(orderItems).set(itemValues).where(and(
                    eq(orderItems.id, preparedItem.id),
                    eq(orderItems.orderId, orderId),
                )),
                db.update(orderItemTaxSnapshots).set({
                    taxClassId: preparedItem.lineTax.taxClassId,
                    taxClassName: preparedItem.lineTax.taxClassName,
                    pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
                    rateSnapshot: JSON.stringify(preparedItem.lineTax.components),
                    createdAt: sql`unixepoch()`,
                }).where(and(
                    eq(orderItemTaxSnapshots.orderItemId, preparedItem.id),
                    eq(orderItemTaxSnapshots.orderId, orderId),
                )),
            );
        } else {
            statements.push(
                db.insert(orderItems).values({
                    id: preparedItem.id,
                    orderId,
                    ...itemValues,
                    createdAt: sql`unixepoch()`,
                }),
                db.insert(orderItemTaxSnapshots).values({
                    orderItemId: preparedItem.id,
                    orderId,
                    taxClassId: preparedItem.lineTax.taxClassId,
                    taxClassName: preparedItem.lineTax.taxClassName,
                    pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
                    rateSnapshot: JSON.stringify(preparedItem.lineTax.components),
                    createdAt: sql`unixepoch()`,
                }),
            );
        }
    }
    const removedIds = existingItems
        .filter((item) => !retainedIds.has(item.id))
        .map((item) => item.id);
    if (removedIds.length > 0) {
        statements.push(db.delete(orderItems).where(and(
            eq(orderItems.orderId, orderId),
            inArray(orderItems.id, removedIds),
        )));
    }
    statements.push(
        db.update(orderTaxSnapshots).set({
            currencyCode: prepared.taxQuote.currencyCode,
            decimalPlaces: prepared.taxQuote.decimalPlaces,
            displayLabel: prepared.taxQuote.displayLabel,
            pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
            shippingTaxed: prepared.taxQuote.shippingTaxed,
            settingsVersion: prepared.taxQuote.settingsVersion,
            calculationVersion: prepared.taxQuote.calculationVersion,
            destinationSnapshot: JSON.stringify(prepared.taxQuote.destination),
            rateSnapshot: JSON.stringify({
                lines: prepared.taxQuote.lines.map((line) => ({
                    lineId: line.lineId,
                    taxClassId: line.taxClassId,
                    taxClassName: line.taxClassName,
                    components: line.components,
                })),
                shipping: prepared.taxQuote.shipping,
            }),
            createdAt: sql`unixepoch()`,
        }).where(eq(orderTaxSnapshots.orderId, orderId)),
        db.update(codTracking).set({ updatedAt: sql`unixepoch()` })
            .where(and(eq(codTracking.orderId, orderId), eq(codTracking.codStatus, "pending"))),
        buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${orders}
            INNER JOIN ${orderAmendments} ON ${orderAmendments.orderId} = ${orders.id}
            WHERE ${orders.id} = ${orderId}
              AND ${orders.version} = ${resultingVersion}
              AND ${orderAmendments.idempotencyKeyHash} = ${keyHash}
              AND ${orderAmendments.resultingVersion} = ${resultingVersion}
        )`, ORDER_AMENDMENT_GUARD_MARKER),
    );

    try {
        await safeBatch(db, statements);
    } catch (error) {
        const raceReplay = await resolveManualOrderAmendmentReplay(db, keyHash, requestHash);
        if (raceReplay) return raceReplay;
        if (
            isBatchGuardError(error, ORDER_AMENDMENT_GUARD_MARKER)
            || isInventoryReservationConflictError(error)
            || isPreparedReservedStockReleaseConflictError(error)
        ) {
            throw new ConflictError(
                "This order changed while the amendment was being confirmed. Reload and review it.",
            );
        }
        throw error;
    }

    await recordOrderEvent(db, {
        orderId,
        kind: "items_edited",
        actorId,
        data: {
            previousTotal: fromMinor(order.totalAmountMinor, order.currencyDecimalPlaces),
            total: totalAmount,
        },
    });
    if (order.customerId) await updateCustomerStatsService(db, order.customerId);
    if (customerId && customerId !== order.customerId) {
        await updateCustomerStatsService(db, customerId);
    }
    return response;
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

async function updateCustomerStatsService(db: Database, customerId: string) {
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

const ORDER_DETAIL_FIELDS = [
    "customerName",
    "customerPhone",
    "customerEmail",
    "shippingAddress",
    "city",
    "zone",
    "area",
] as const;

/**
 * Corrects the customer and delivery details of an order that has not shipped
 * (the phone-confirmation call). Money, items and tax snapshots are untouched;
 * a changed phone links the order to that phone's customer.
 */
export async function updateOrderDetails(
    db: Database,
    orderId: string,
    data: UpdateOrderDetailsInput,
): Promise<{ id: string; version: number; changedFields: string[] }> {
    const order = await db.select().from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.version !== data.expectedVersion) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    const readiness = await getOrderEditReadiness(db, orderId);
    if (!readiness?.details.allowed) {
        throw new ConflictError(orderEditLockMessage(readiness?.details.reason ?? null));
    }
    const next = {
        customerName: data.customerName.trim(),
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail?.trim().toLowerCase() || null,
        shippingAddress: data.shippingAddress.trim(),
        city: data.city,
        zone: data.zone,
        area: data.area,
    };
    const changedFields = ORDER_DETAIL_FIELDS.filter((field) => (order[field] ?? null) !== next[field]);
    if (changedFields.length === 0) return { id: orderId, version: order.version, changedFields: [] };
    if (next.customerPhone !== order.customerPhone) {
        await validateCustomerPhoneCountry(db, next.customerPhone);
    }
    const locationNames = await resolveActiveDeliveryLocationNames(db, next);

    let customerId = order.customerId;
    let newCustomerId: string | null = null;
    if (next.customerPhone !== order.customerPhone || !customerId) {
        const existingCustomer = await db.select({ id: customers.id }).from(customers)
            .where(eq(customers.phone, next.customerPhone)).get();
        customerId = existingCustomer?.id ?? `cust_${nanoid()}`;
        if (!existingCustomer) newCustomerId = customerId;
    }

    const resultingVersion = order.version + 1;
    const statements: SQLiteBatchItem[] = [];
    if (newCustomerId) {
        statements.push(db.insert(customers).values({
            id: newCustomerId,
            name: next.customerName,
            email: next.customerEmail,
            phone: next.customerPhone,
            address: next.shippingAddress,
            city: next.city,
            zone: next.zone,
            area: next.area,
            ...locationNames,
            totalOrders: 1,
            lastOrderAt: sql`unixepoch()`,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }));
    }
    statements.push(db.update(orders).set({
        ...next,
        ...locationNames,
        customerId,
        version: resultingVersion,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version),
        isNull(orders.archivedAt),
        inArray(orders.status, [...OPEN_ORDER_STATUSES]),
        eq(orders.fulfillmentStatus, FulfillmentStatus.PENDING),
        isNull(orders.shipmentClaimId),
        sql`NOT EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.orderId} = ${orderId})`,
    )).returning({ id: orders.id }));
    const results = await safeBatch(db, statements as never) as unknown[][];
    if ((results.at(-1) ?? []).length === 0) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    if (order.customerId) await updateCustomerStatsService(db, order.customerId);
    if (customerId && customerId !== order.customerId) await updateCustomerStatsService(db, customerId);
    return { id: orderId, version: resultingVersion, changedFields: [...changedFields] };
}

export async function restoreOrder(db: Database, id: string, expectedVersion: number) {
    const order = await db
        .select({
            id: orders.id,
            archivedAt: orders.archivedAt,
            deletedAt: orders.deletedAt,
            version: orders.version,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    if (order.deletedAt) throw new ValidationError("This legacy-deleted order cannot be restored from the archive.");
    if (!order.archivedAt) throw new ValidationError("Order is not archived");
    if (order.version !== expectedVersion) {
        throw new ConflictError("Order was modified by another request. Reload and try again.");
    }

    const restored = await db
        .update(orders)
        .set({
            archivedAt: null,
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, id),
            eq(orders.version, expectedVersion),
            isNull(orders.deletedAt),
            isNotNull(orders.archivedAt),
        ))
        .returning({ id: orders.id });

    if (restored.length === 0) {
        throw new ConflictError("Order was modified by another request. Reload and try again.");
    }
}

/**
 * Removes completed commerce records from the default admin list without
 * changing their lifecycle or destroying evidence. Archive/restore never
 * touches payment, fulfillment, returns, refunds, inventory, or order items.
 */
export async function archiveOrders(
    db: Database,
    requestedOrders: ArchiveOrdersInput["orders"],
) {
    if (requestedOrders.length === 0 || requestedOrders.length > 90) {
        throw new ValidationError("Archive between 1 and 90 orders at a time.");
    }

    const requestById = new Map<string, number>();
    for (const request of requestedOrders) {
        if (requestById.has(request.id)) {
            throw new ValidationError("Each order can appear only once.");
        }
        requestById.set(request.id, request.expectedVersion);
    }

    const requestedIds = [...requestById.keys()];
    const affectedOrders = await db
        .select({
            id: orders.id,
            status: orders.status,
            version: orders.version,
            archivedAt: orders.archivedAt,
            deletedAt: orders.deletedAt,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(inArray(orders.id, requestedIds));

    if (affectedOrders.length !== requestedIds.length) {
        throw new NotFoundError("One or more orders no longer exist. Reload and try again.");
    }

    for (const order of affectedOrders) {
        if (order.deletedAt) {
            throw new ValidationError("A legacy-deleted order cannot be archived.");
        }
        if (order.archivedAt) {
            throw new ValidationError("One or more orders are already archived. Reload and try again.");
        }
        if (order.version !== requestById.get(order.id)) {
            throw new ConflictError("One or more orders changed. Reload and review them before archiving.");
        }
        const statusReason = getOrderArchiveStatusBlockedReason(order.status);
        if (statusReason) throw new ValidationError(statusReason, { orderId: order.id });
        assertNoActiveShipmentClaim(order);
        await assertNoActiveReturnReceipt(db, order.id);
    }

    await assertNoActiveRefundAttemptsForOrders(db, requestedIds);
    await assertNoActivePaymentSessionAttemptsForOrders(db, requestedIds);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const statements = requestedOrders.map(({ id, expectedVersion }) =>
        db
            .update(orders)
            .set({
                archivedAt: sql`unixepoch()`,
                version: sql`${orders.version} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(orders.id, id),
                eq(orders.version, expectedVersion),
                isNull(orders.deletedAt),
                isNull(orders.archivedAt),
                sql`${orders.status} IN ('cancelled', 'completed', 'returned', 'refunded')`,
                sql`(${orders.shipmentClaimId} IS NULL OR ${orders.shipmentClaimExpiresAt} IS NULL OR ${orders.shipmentClaimExpiresAt} <= ${nowSeconds})`,
                noActiveRefundAttemptForOrderIdCondition(id),
                noActivePaymentSessionAttemptForOrderIdCondition(id),
            ))
            .returning({ id: orders.id }),
    );
    const results = await safeBatch(db, statements as SQLiteBatchItem[]) as { id: string }[][];
    if (results.some((result) => !result || result.length === 0)) {
        throw new ConflictError("One or more orders changed. Reload and try again.");
    }
}
