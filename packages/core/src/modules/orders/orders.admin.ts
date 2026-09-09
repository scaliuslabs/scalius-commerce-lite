// src/modules/orders/orders.admin.ts
// Admin order service: queries and CRUD mutations.

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
    adminOrderCreateAttempts,
    orderInvoices,
    orderReturns,
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
    applyClaimedInventoryEntryBatch,
    applyInventoryForStatusChange,
    isStockDeductStatus,
    isStockRestoreStatus,
} from "../inventory/inventory-transitions";
import {
    prepareStockReservationBatch,
    prepareReservedStockReleaseBatch,
    isInventoryReservationConflictError,
    isPreparedReservedStockReleaseConflictError,
    reserveStockBatch,
    releaseReservedStockBatch,
    validateStockBatchAvailability,
} from "../inventory";
import type { ReservationEntry } from "../inventory";

import { sql, desc, eq, inArray, isNotNull, isNull, and, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
    ftsMatch,
    isFts5SearchEnabled,
    sanitizeFtsQuery,
} from "../../search/fts5";
import { generateOrderId } from "@scalius/shared/order-utils";
import { calculateCustomerStats } from "@scalius/shared/customer-utils";
import { calculateDiscountedPriceAtPrecision } from "@scalius/shared/price-utils";
import { normalizeOrderStatus } from "@scalius/shared/order-state";
import { unixToDate } from "@scalius/shared/utils";
import { nanoid } from "nanoid";
import type {
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
    AdminOrderFullEditReadiness,
    AdminOrderAmendmentReadiness,
    OrderPaymentRecoveryFilter,
    OrderPaymentRecoverySummary,
    OrderShipmentRecoverySummary,
    OrderShipmentSummary,
} from "./orders.types";
import { getOrderStatusGroupStatuses, type OrderStatusGroup } from "./order-list-views";
import { buildPhoneSearchTerms, isLikelyPhoneSearch } from "./orders.search";
import { assertNoActiveShipmentClaim, hasActiveShipmentClaim } from "./shipment-claim";
import { PROVIDER_OUTCOME_UNKNOWN } from "../delivery/types";
import { computeOrderPaymentState } from "../payments/payment-state";
import { createCODTrackingInsertValues } from "../payments/cod";
import {
    createOrderCurrencySnapshot,
    resolveOrderCurrencySnapshot,
    roundOrderMoney,
    type OrderCurrencySnapshot,
} from "../payments/order-currency";
import { getCurrencySettings } from "../settings/site-settings.service";
import { validateCustomerPhoneCountry } from "../settings/phone-country-policy";
import {
    buildStorefrontTaxAllocationLineId,
    calculateStorefrontTaxQuote,
    fromMinorUnits,
    toMinorUnits,
    type TaxQuote,
} from "../tax";
import {
    assertNoActiveRefundAttempt,
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
    assertNoActivePaymentSessionAttempt,
    assertNoActivePaymentSessionAttemptsForOrders,
    noActivePaymentSessionAttemptForOrderIdCondition,
    listOrderPaymentSessionAttempts,
} from "../payments/payment-session-attempts";
import { PAYMENT_BLOCKED_ORDER_STATUSES } from "../payments/payable-order";
import { resolveActiveDeliveryLocationNames } from "./delivery-location-validation";
import { listOrderSupportRequests } from "./order-support-requests";
import { createOrderReceiptToken, recordOrderReceipt } from "./order-receipts";
import {
    assertNoActiveReturnReceipt,
    assertOrderItemsHaveNoReturnHistory,
} from "./order-returns";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
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
const ORDER_ITEM_TAX_INSERT_PARAMETERS_PER_ROW = 13;
const ORDER_AMENDMENT_GUARD_MARKER = "ORDER_AMENDMENT_CONFLICT";

export interface AdminOrderFullEditSource {
    status: string;
    paymentStatus: string | null;
    paidAmount: number | null;
    fulfillmentStatus: string | null;
    shipmentClaimId: string | null;
    shipmentClaimExpiresAt: Date | number | string | null;
    hasTaxSnapshot: number | boolean;
    hasPaymentHistory: number | boolean;
    hasShipmentHistory: number | boolean;
    hasRefundHistory: number | boolean;
    hasReturnHistory: number | boolean;
    hasInvoiceHistory: number | boolean;
    checkoutAggregateVersion?: number | null;
    checkoutProjectionStatus?: string | null;
}

const FULL_EDITABLE_ORDER_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);

export function buildAdminOrderFullEditReadiness(
    order: AdminOrderFullEditSource,
): AdminOrderFullEditReadiness {
    if (
        order.checkoutAggregateVersion === 1
        && order.checkoutProjectionStatus !== "complete"
    ) {
        return {
            allowed: false,
            reason: "This checkout is still materializing its read models. Retry after projection completes.",
        };
    }
    if (!FULL_EDITABLE_ORDER_STATUSES.has(order.status)) {
        return {
            allowed: false,
            reason: "The full editor is available only before shipment, cancellation, completion, return, or refund. Use the dedicated order actions instead.",
        };
    }
    if (
        order.paymentStatus !== PaymentStatus.UNPAID
        || (order.paidAmount ?? 0) !== 0
        || Boolean(order.hasPaymentHistory)
        || Boolean(order.hasRefundHistory)
    ) {
        return {
            allowed: false,
            reason: "Payment or refund evidence already exists. Use payment, refund, or replacement-order workflows instead of rewriting the order.",
        };
    }
    if (
        order.fulfillmentStatus !== FulfillmentStatus.PENDING
        || Boolean(order.hasShipmentHistory)
        || hasActiveShipmentClaim(order)
    ) {
        return {
            allowed: false,
            reason: "Fulfillment or shipment evidence already exists. Use the shipment, return, or replacement-order workflows instead.",
        };
    }
    if (order.hasTaxSnapshot) {
        return {
            allowed: false,
            reason: "This checkout order has immutable tax and line snapshots. Use a refund, return, or replacement order so the original receipt remains accurate.",
        };
    }
    if (Boolean(order.hasReturnHistory) || Boolean(order.hasInvoiceHistory)) {
        return {
            allowed: false,
            reason: "Return or invoice evidence already exists. Create an amendment or replacement order instead of rewriting this order.",
        };
    }
    return { allowed: true, reason: null };
}

function adminOrderFullEditEvidenceSelection() {
    return {
        hasTaxSnapshot: sql<number>`EXISTS (
            SELECT 1 FROM ${orderTaxSnapshots}
            WHERE ${orderTaxSnapshots.orderId} = ${orders.id}
        )`,
        hasPaymentHistory: sql<number>`EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orders.id}
        )`,
        hasShipmentHistory: sql<number>`EXISTS (
            SELECT 1 FROM ${deliveryShipments}
            WHERE ${deliveryShipments.orderId} = ${orders.id}
        )`,
        hasRefundHistory: sql<number>`EXISTS (
            SELECT 1 FROM ${refundAttempts}
            WHERE ${refundAttempts.orderId} = ${orders.id}
        )`,
        hasReturnHistory: sql<number>`EXISTS (
            SELECT 1 FROM ${orderReturns}
            WHERE ${orderReturns.orderId} = ${orders.id}
        )`,
        hasInvoiceHistory: sql<number>`EXISTS (
            SELECT 1 FROM ${orderInvoices}
            WHERE ${orderInvoices.orderId} = ${orders.id}
        )`,
    };
}

type AdminOrderFullEditEvidence = Pick<
    AdminOrderFullEditSource,
    | "hasTaxSnapshot"
    | "hasPaymentHistory"
    | "hasShipmentHistory"
    | "hasRefundHistory"
    | "hasReturnHistory"
    | "hasInvoiceHistory"
>;

function omitAdminOrderFullEditEvidence<T extends AdminOrderFullEditEvidence>(
    order: T,
): Omit<T, keyof AdminOrderFullEditEvidence> {
    const {
        hasTaxSnapshot: _hasTaxSnapshot,
        hasPaymentHistory: _hasPaymentHistory,
        hasShipmentHistory: _hasShipmentHistory,
        hasRefundHistory: _hasRefundHistory,
        hasReturnHistory: _hasReturnHistory,
        hasInvoiceHistory: _hasInvoiceHistory,
        ...publicOrder
    } = order;
    return publicOrder;
}

export async function getAdminOrderFullEditReadiness(
    db: Database,
    orderId: string,
): Promise<AdminOrderFullEditReadiness | null> {
    const order = await db
        .select({
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            paidAmount: orders.paidAmount,
            fulfillmentStatus: orders.fulfillmentStatus,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            checkoutAggregateVersion: orders.checkoutAggregateVersion,
            checkoutProjectionStatus: orders.checkoutProjectionStatus,
            ...adminOrderFullEditEvidenceSelection(),
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .get();

    return order ? buildAdminOrderFullEditReadiness(order) : null;
}

export interface AdminOrderAmendmentSource {
    status: string;
    paymentMethod: string | null;
    paymentStatus: string | null;
    paidAmount: number | null;
    fulfillmentStatus: string | null;
    inventoryAction: string | null;
    shipmentClaimId: string | null;
    isManualOrder: number | boolean;
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

export function buildAdminOrderAmendmentReadiness(
    order: AdminOrderAmendmentSource,
): AdminOrderAmendmentReadiness {
    if (!order.isManualOrder || order.paymentMethod !== PaymentMethod.COD) {
        return {
            allowed: false,
            reason: "Only manually created Cash on Delivery orders can be amended here.",
        };
    }
    if (
        order.status !== OrderStatus.PENDING
        && order.status !== OrderStatus.PROCESSING
        && order.status !== OrderStatus.CONFIRMED
    ) {
        return {
            allowed: false,
            reason: "This order has already progressed beyond the amendment window.",
        };
    }
    if (
        order.paymentStatus !== PaymentStatus.UNPAID
        || (order.paidAmount ?? 0) !== 0
        || Boolean(order.hasPaymentHistory)
        || Boolean(order.hasPaymentSessionHistory)
        || Boolean(order.hasPaymentPlan)
        || !order.hasCleanCodTracking
    ) {
        return {
            allowed: false,
            reason: "Payment or collection activity already exists. Use the payment or replacement-order workflow.",
        };
    }
    if (
        order.fulfillmentStatus !== FulfillmentStatus.PENDING
        || Boolean(order.hasShipmentHistory)
        || Boolean(order.shipmentClaimId)
        || Boolean(order.hasNonPendingItem)
        || order.inventoryAction === "deducted"
    ) {
        return {
            allowed: false,
            reason: "Fulfillment or shipment activity already exists. Use the shipment, return, or replacement-order workflow.",
        };
    }
    if (
        Boolean(order.hasRefundHistory)
        || Boolean(order.hasReturnHistory)
        || Boolean(order.hasInvoiceHistory)
    ) {
        return {
            allowed: false,
            reason: "Refund, return, or invoice evidence makes this order immutable.",
        };
    }
    if (!order.hasTaxSnapshot || Boolean(order.hasPromotionAllocation)) {
        return {
            allowed: false,
            reason: "This order does not have an amendment-safe manual money snapshot.",
        };
    }
    if (order.inventoryAction !== "reserved" && order.inventoryAction !== "none") {
        return {
            allowed: false,
            reason: "Inventory state must be reconciled before this order can be amended.",
        };
    }
    return { allowed: true, reason: null };
}

function adminOrderAmendmentSelection(orderId: string) {
    return {
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        paidAmount: orders.paidAmount,
        fulfillmentStatus: orders.fulfillmentStatus,
        inventoryAction: orders.inventoryAction,
        shipmentClaimId: orders.shipmentClaimId,
        isManualOrder: sql<number>`EXISTS (
            SELECT 1 FROM ${adminOrderCreateAttempts}
            WHERE ${adminOrderCreateAttempts.orderId} = ${orderId}
              AND ${adminOrderCreateAttempts.status} = 'committed'
        )`,
        hasTaxSnapshot: sql<number>`EXISTS (SELECT 1 FROM ${orderTaxSnapshots} WHERE ${orderTaxSnapshots.orderId} = ${orderId})`,
        hasPaymentHistory: sql<number>`EXISTS (SELECT 1 FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})`,
        hasPaymentSessionHistory: sql<number>`EXISTS (SELECT 1 FROM ${paymentSessionAttempts} WHERE ${paymentSessionAttempts.orderId} = ${orderId})`,
        hasShipmentHistory: sql<number>`EXISTS (SELECT 1 FROM ${deliveryShipments} WHERE ${deliveryShipments.orderId} = ${orderId})`,
        hasRefundHistory: sql<number>`EXISTS (SELECT 1 FROM ${refundAttempts} WHERE ${refundAttempts.orderId} = ${orderId})`,
        hasReturnHistory: sql<number>`EXISTS (SELECT 1 FROM ${orderReturns} WHERE ${orderReturns.orderId} = ${orderId})`,
        hasInvoiceHistory: sql<number>`EXISTS (SELECT 1 FROM ${orderInvoices} WHERE ${orderInvoices.orderId} = ${orderId})`,
        hasPaymentPlan: sql<number>`EXISTS (SELECT 1 FROM ${paymentPlans} WHERE ${paymentPlans.orderId} = ${orderId})`,
        hasPromotionAllocation: sql<number>`EXISTS (SELECT 1 FROM ${orderDiscountAllocations} WHERE ${orderDiscountAllocations.orderId} = ${orderId})`,
        hasNonPendingItem: sql<number>`EXISTS (
            SELECT 1 FROM ${orderItems}
            WHERE ${orderItems.orderId} = ${orderId}
              AND ${orderItems.fulfillmentStatus} <> ${ItemFulfillmentStatus.PENDING}
        )`,
        hasCleanCodTracking: sql<number>`EXISTS (
            SELECT 1 FROM ${codTracking}
            WHERE ${codTracking.orderId} = ${orderId}
              AND ${codTracking.codStatus} = 'pending'
              AND ${codTracking.collectedAt} IS NULL
              AND COALESCE(${codTracking.collectedAmount}, 0) = 0
        )`,
    };
}

export async function getAdminOrderAmendmentReadiness(
    db: Database,
    orderId: string,
): Promise<AdminOrderAmendmentReadiness | null> {
    const order = await db.select(adminOrderAmendmentSelection(orderId))
        .from(orders)
        .where(and(
            eq(orders.id, orderId),
            isNull(orders.deletedAt),
            isNull(orders.archivedAt),
        ))
        .get();
    return order ? buildAdminOrderAmendmentReadiness(order) : null;
}

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
    catalogUnitPrice: number | null;
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
    if (normalizedDiscount > subtotal) {
        throw new ValidationError(
            "Discount amount cannot exceed the manual order subtotal.",
            {
                reason: "MANUAL_ORDER_DISCOUNT_EXCEEDS_SUBTOTAL",
                maximumDiscountAmountMinor: toMinorUnits(
                    subtotal,
                    currency.decimalPlaces,
                ),
                currencyCode: currency.code,
                decimalPlaces: currency.decimalPlaces,
            },
        );
    }
    const grossAmount = roundOrderMoney(subtotal + normalizedShipping, currency);
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
    const fromMinor = (value: number) => fromMinorUnits(value, taxQuote.decimalPlaces);
    return {
        currencyCode: taxQuote.currencyCode,
        decimalPlaces: taxQuote.decimalPlaces,
        subtotalAmount: fromMinor(taxQuote.subtotalMinor),
        shippingAmount: fromMinor(taxQuote.shippingMinor),
        discountAmount: fromMinor(taxQuote.discountMinor),
        taxAmount: fromMinor(taxQuote.taxMinor),
        totalAmount: fromMinor(taxQuote.totalMinor),
        taxLabel: taxQuote.displayLabel,
        pricesIncludeTax: taxQuote.pricesIncludeTax,
        taxEnabled: taxQuote.enabled,
        settingsVersion: taxQuote.settingsVersion,
        lines: trackedItems.map((item, index) => ({
            index,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: item.price,
            lineSubtotal: fromMinor(taxQuote.lines[index]?.grossAmountMinor ?? 0),
        })),
    };
}

async function prepareManualOrderQuote(
    db: Database,
    data: QuoteManualOrderInput,
    currencyOverride?: OrderCurrencySnapshot,
): Promise<PreparedManualOrderQuote> {
    const currency = currencyOverride ?? createOrderCurrencySnapshot(
        (await getCurrencySettings(db)).currencyCode,
    );
    // Keep location validation first so a stale/cross-parent destination fails
    // before catalog or tax reads do unnecessary work.
    const locationNames = await resolveActiveDeliveryLocationNames(db, data);
    const resolvedItems = await resolveAdminOrderItemInventory(
        db,
        data.items,
        { catalogPricePrecision: currency.decimalPlaces },
    );
    const money = calculateManualOrderMoney(
        resolvedItems.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            price: item.catalogUnitPrice!,
        })),
        data.shippingCharge,
        data.discountAmount,
        currency,
    );
    const trackedItems = resolvedItems.map((item, index) => ({
        ...item,
        price: money.normalizedItems[index]!.price,
    }));
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
            unitPrice: item.price,
            quantity: item.quantity,
            taxClassId: item.taxClassId,
        })),
        shippingAmount: money.shippingCharge,
        discountAmount: money.discountAmount,
        discountType: money.discountAmount > 0 ? "amount_off_order" : null,
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

function paymentRecoveryLifecycleCondition() {
    const orderIdSql = sql`${orders.id}`;
    // Open orders retain their existing recovery policy. Closed orders need
    // current provider/money work; completed partial refunds may retain money.
    return sql<number>`CASE
        WHEN NOT ${inArray(orders.status, [...PAYMENT_BLOCKED_ORDER_STATUSES])} THEN 1
        WHEN ${inArray(orders.status, [OrderStatus.CANCELLED, OrderStatus.RETURNED])}
            AND ${orders.paidAmount} > 0 THEN 1
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
    const isClosed = (PAYMENT_BLOCKED_ORDER_STATUSES as readonly string[]).includes(order.status);
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
                ? "This closed order still has payment activity to reconcile. Review the order payment panel."
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
    options: { catalogPricePrecision?: number } = {},
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
            productDiscountPercentage: products.discountPercentage,
            productDiscountAmount: products.discountAmount,
            variantPrice: productVariants.price,
            variantDiscountType: productVariants.discountType,
            variantDiscountPercentage: productVariants.discountPercentage,
            variantDiscountAmount: productVariants.discountAmount,
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
            (sku.variantDiscountType === "percentage" && (sku.variantDiscountPercentage ?? 0) > 0)
            || (sku.variantDiscountType === "flat" && (sku.variantDiscountAmount ?? 0) > 0);
        const catalogUnitPrice = options.catalogPricePrecision == null
            ? null
            : calculateDiscountedPriceAtPrecision(
                sku.variantPrice,
                variantHasDiscount ? sku.variantDiscountType : sku.productDiscountType,
                variantHasDiscount
                    ? sku.variantDiscountPercentage
                    : sku.productDiscountPercentage,
                variantHasDiscount ? sku.variantDiscountAmount : sku.productDiscountAmount,
                options.catalogPricePrecision,
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
            catalogUnitPrice,
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
    statusGroup?: OrderStatusGroup;
    paymentStatus?: string;
    paymentMethod?: string;
    fulfillmentStatus?: string;
    paymentRecovery?: OrderPaymentRecoveryFilter;
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
        statusGroup,
        paymentStatus,
        paymentMethod,
        fulfillmentStatus,
        paymentRecovery,
        page: rawPage = 1,
        limit: rawLimit = 10,
        showArchived = false,
        sort = "updatedAt",
        order = "desc",
        startDate,
        endDate,
    } = options;
    const page = normalizeListPositiveInteger(rawPage, 1);
    const limit = normalizeListPositiveInteger(rawLimit, 10, MAX_ORDER_LIST_LIMIT);
    const offset = (page - 1) * limit;

    const whereConditions: SQL[] = [];

    if (showArchived) {
        whereConditions.push(sql`${orders.deletedAt} IS NULL`);
        whereConditions.push(sql`${orders.archivedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${orders.deletedAt} IS NULL`);
        whereConditions.push(sql`${orders.archivedAt} IS NULL`);
    }

    let rankExpression: SQL | undefined = undefined;
    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
        const phoneSearchTerms = buildPhoneSearchTerms(trimmedSearch);
        const phoneCondition = buildPhoneSearchCondition(phoneSearchTerms);
        const ftsCondition = ftsMatch(db, "orders_fts", "orders", trimmedSearch);

        if (isLikelyPhoneSearch(trimmedSearch) && phoneCondition) {
            whereConditions.push(ftsCondition ? sql`(${ftsCondition} OR ${phoneCondition})` : phoneCondition);
            if (isFts5SearchEnabled(db)) {
                const sanitized = sanitizeFtsQuery(trimmedSearch);
                rankExpression = sql`
                    COALESCE(
                        (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}),
                        999999
                    ) ASC
                `;
            }
        } else if (ftsCondition) {
            whereConditions.push(ftsCondition);
            if (isFts5SearchEnabled(db)) {
                const sanitized = sanitizeFtsQuery(trimmedSearch);
                rankExpression = sql`
                    COALESCE(
                        (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}),
                        999999
                    ) ASC
                `;
            }
        }
    }

    if (status) {
        whereConditions.push(sql`${orders.status} = ${status}`);
    } else if (statusGroup) {
        whereConditions.push(inArray(orders.status, [...getOrderStatusGroupStatuses(statusGroup)]));
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
            version: orders.version,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            cityName: orders.cityName,
            zoneName: orders.zoneName,
            areaName: orders.areaName,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            paidAmount: orders.paidAmount,
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...adminOrderFullEditEvidenceSelection(),
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
        createdAt: number; updatedAt: number; version: number;
        city: string | null; zone: string | null; area: string | null;
        cityName: string | null; zoneName: string | null; areaName: string | null;
        shipmentClaimId: string | null; shipmentClaimExpiresAt: Date | number | string | null;
        paidAmount: number | null;
        paymentRecoveryApplicable: number;
        hasTaxSnapshot: number; hasPaymentHistory: number; hasShipmentHistory: number;
        hasRefundHistory: number; hasReturnHistory: number; hasInvoiceHistory: number;
    }[];
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
        const { paymentRecoveryApplicable: _paymentRecoveryApplicable, ...publicOrder } = omitAdminOrderFullEditEvidence(order);
        return {
            ...publicOrder,
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
            fullEditReadiness: buildAdminOrderFullEditReadiness(order),
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
            totalAmount: orders.totalAmount,
            shippingCharge: orders.shippingCharge,
            discountAmount: orders.discountAmount,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            subtotalAmountMinor: orders.subtotalAmountMinor,
            shippingAmountMinor: orders.shippingAmountMinor,
            shippingMethodId: orders.shippingMethodId,
            shippingMethodName: orders.shippingMethodName,
            shippingMethodDescription: orders.shippingMethodDescription,
            shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
            shippingFeeWaived: orders.shippingFeeWaived,
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
            paymentRecoveryApplicable: paymentRecoveryLifecycleCondition(),
            ...adminOrderFullEditEvidenceSelection(),
        })
        .from(orders)
        .where(eq(orders.id, id))
        .get();

    if (!order) return null;

    const amendmentReadiness = await getAdminOrderAmendmentReadiness(db, id);
    if (!amendmentReadiness) return null;

    const [items, latestShipments, refundAttemptViews, supportRequests, promotionRows, paymentAttempts] = await Promise.all([
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
        db
            .select({
                id: orderDiscountAllocations.promotionId,
                revision: orderDiscountAllocations.promotionRevision,
                evaluatorVersion: orderDiscountAllocations.evaluatorVersion,
                method: orderDiscountAllocations.method,
                name: orderDiscountAllocations.promotionName,
                code: orderDiscountAllocations.promotionCode,
            })
            .from(orderDiscountAllocations)
            .where(eq(orderDiscountAllocations.orderId, id))
            .orderBy(orderDiscountAllocations.id)
            .limit(1),
        listOrderPaymentSessionAttempts(db, id),
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
    const { paymentRecoveryApplicable: _paymentRecoveryApplicable, ...publicOrder } = omitAdminOrderFullEditEvidence(order);

    return {
        ...publicOrder,
        createdAt: new Date(order.createdAt * 1000),
        updatedAt: new Date(order.updatedAt * 1000),
        deletedAt: order.deletedAt ? new Date(order.deletedAt * 1000) : null,
        promotion: promotionRows[0] ?? null,
        items: formattedItems,
        itemCount: formattedItems.length,
        latestShipment,
        shipmentRecovery: buildShipmentRecoverySummary(order, latestShipment, nowSeconds),
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        supportRequests,
        paymentRecovery: buildPaymentRecoverySummary(order, paymentAttempts, nowSeconds),
        fullEditReadiness: buildAdminOrderFullEditReadiness(order),
        amendmentReadiness,
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
            currency,
            locationNames: { cityName, zoneName, areaName },
            trackedItems,
            allocationLineIds,
            taxQuote,
            quote,
        } = manualQuote;
        const totalAmount = quote.totalAmount;
        const initialPaymentState = computeOrderPaymentState({
            totalAmount,
            paidAmount: 0,
            currency,
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
            totalAmount,
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
        totalAmount,
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
                totalOrders: sql`${customers.totalOrders} + 1`,
                totalSpent: sql`${customers.totalSpent} + ${initialPaymentState.paidAmount}`,
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
            shippingCharge: quote.shippingAmount,
            discountAmount: quote.discountAmount,
            currencyCode: taxQuote.currencyCode,
            currencyDecimalPlaces: taxQuote.decimalPlaces,
            subtotalAmountMinor: taxQuote.subtotalMinor,
            shippingAmountMinor: taxQuote.shippingMinor,
            discountAmountMinor: taxQuote.discountMinor,
            taxAmountMinor: taxQuote.taxMinor,
            totalAmountMinor: taxQuote.totalMinor,
            taxLabel: taxQuote.displayLabel,
            pricesIncludeTax: taxQuote.pricesIncludeTax,
            paidAmount: initialPaymentState.paidAmount,
            balanceDue: initialPaymentState.balanceDue,
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
            price: item.price,
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
            unitPriceMinor: lineTax.unitPriceMinor,
            quantity: lineTax.quantity,
            grossAmountMinor: lineTax.grossAmountMinor,
            discountMinor: lineTax.discountMinor,
            taxableAmountMinor: lineTax.taxableAmountMinor,
            taxMinor: lineTax.taxMinor,
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
            subtotalMinor: taxQuote.subtotalMinor,
            shippingMinor: taxQuote.shippingMinor,
            discountMinor: taxQuote.discountMinor,
            taxableMinor: taxQuote.taxableMinor,
            taxMinor: taxQuote.taxMinor,
            totalMinor: taxQuote.totalMinor,
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
    const readiness = await getAdminOrderAmendmentReadiness(db, orderId);
    if (!readiness?.allowed) {
        throw new ConflictError(readiness?.reason ?? "This order cannot be amended.");
    }
    return order;
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
          AND ${orders.paidAmount} = 0
          AND ${orders.fulfillmentStatus} = ${FulfillmentStatus.PENDING}
          AND ${orders.status} IN (${OrderStatus.PENDING}, ${OrderStatus.PROCESSING}, ${OrderStatus.CONFIRMED})
          AND ${orders.shipmentClaimId} IS NULL
          AND ${orders.inventoryAction} IN ('reserved', 'none')
          AND EXISTS (
            SELECT 1 FROM ${adminOrderCreateAttempts}
            WHERE ${adminOrderCreateAttempts.orderId} = ${orderId}
              AND ${adminOrderCreateAttempts.status} = 'committed'
          )
          AND EXISTS (
            SELECT 1 FROM ${orderTaxSnapshots}
            WHERE ${orderTaxSnapshots.orderId} = ${orderId}
          )
          AND EXISTS (
            SELECT 1 FROM ${codTracking}
            WHERE ${codTracking.orderId} = ${orderId}
              AND ${codTracking.codStatus} = 'pending'
              AND ${codTracking.collectedAt} IS NULL
              AND COALESCE(${codTracking.collectedAmount}, 0) = 0
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
    );
    const currentQuoteFingerprint = await buildManualOrderAmendmentQuoteFingerprint(prepared.taxQuote);
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
            balanceDue: totalAmount,
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
            totalSpent: 0,
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
            totalAmount,
            shippingCharge: prepared.quote.shippingAmount,
            discountAmount: prepared.quote.discountAmount,
            currencyCode: prepared.taxQuote.currencyCode,
            currencyDecimalPlaces: prepared.taxQuote.decimalPlaces,
            subtotalAmountMinor: prepared.taxQuote.subtotalMinor,
            shippingAmountMinor: prepared.taxQuote.shippingMinor,
            discountAmountMinor: prepared.taxQuote.discountMinor,
            taxAmountMinor: prepared.taxQuote.taxMinor,
            totalAmountMinor: prepared.taxQuote.totalMinor,
            taxLabel: prepared.taxQuote.displayLabel,
            pricesIncludeTax: prepared.taxQuote.pricesIncludeTax,
            paidAmount: 0,
            balanceDue: totalAmount,
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
            price: preparedItem.item.price,
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
                    unitPriceMinor: preparedItem.lineTax.unitPriceMinor,
                    quantity: preparedItem.lineTax.quantity,
                    grossAmountMinor: preparedItem.lineTax.grossAmountMinor,
                    discountMinor: preparedItem.lineTax.discountMinor,
                    taxableAmountMinor: preparedItem.lineTax.taxableAmountMinor,
                    taxMinor: preparedItem.lineTax.taxMinor,
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
                    unitPriceMinor: preparedItem.lineTax.unitPriceMinor,
                    quantity: preparedItem.lineTax.quantity,
                    grossAmountMinor: preparedItem.lineTax.grossAmountMinor,
                    discountMinor: preparedItem.lineTax.discountMinor,
                    taxableAmountMinor: preparedItem.lineTax.taxableAmountMinor,
                    taxMinor: preparedItem.lineTax.taxMinor,
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
            subtotalMinor: prepared.taxQuote.subtotalMinor,
            shippingMinor: prepared.taxQuote.shippingMinor,
            discountMinor: prepared.taxQuote.discountMinor,
            taxableMinor: prepared.taxQuote.taxableMinor,
            taxMinor: prepared.taxQuote.taxMinor,
            totalMinor: prepared.taxQuote.totalMinor,
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

    if (order.customerId) await updateCustomerStatsService(db, order.customerId);
    if (customerId && customerId !== order.customerId) {
        await updateCustomerStatsService(db, customerId);
    }
    return response;
}

interface UpdateOrderItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
    inventoryTracked?: boolean;
}

interface UpdateOrderData {
    expectedVersion: number;
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

export async function updateOrder(
    db: Database,
    id: string,
    data: UpdateOrderData,
): Promise<{ id: string; inventoryMutationVariantIds: string[] }> {
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
    if (existingOrder.version !== data.expectedVersion) {
        throw new ConflictError(
            "This order changed after you opened it. Reload the editor and review the latest values before saving.",
        );
    }
    const expectedVersion = data.expectedVersion;
    const fullEditReadiness = await getAdminOrderFullEditReadiness(db, id);
    if (!fullEditReadiness) throw new NotFoundError("Order not found");
    if (!fullEditReadiness.allowed) {
        throw new ConflictError(
            fullEditReadiness.reason ?? "This order can no longer be changed in the full editor.",
        );
    }
    if (data.customerPhone !== existingOrder.customerPhone) {
        await validateCustomerPhoneCountry(db, data.customerPhone);
    }
    const { cityName, zoneName, areaName } = await resolveActiveDeliveryLocationNames(db, data);
    const currentStatus = normalizeOrderStatus(existingOrder.status);
    if (!currentStatus) {
        throw new ValidationError("Order has an unknown current status.");
    }
    const nextStatus = normalizeOrderStatus(data.status);
    if (!nextStatus) {
        throw new ValidationError("Unknown order status.");
    }
    if (nextStatus !== currentStatus) {
        throw new ValidationError(
            "Use the order status action for operational progress. The full editor only changes customer, item, shipping-charge, and discount details.",
        );
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
                { reservationKey: adminOrderInventoryClaimKey(id, expectedVersion, "reserve-positive") },
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
                { reservationKey: adminOrderInventoryClaimKey(id, expectedVersion, "reserve-positive-deducted") },
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
                    claimKey: adminOrderInventoryClaimKey(id, expectedVersion, "deduct-positive"),
                    pool,
                });
            } catch (error: unknown) {
                await compensatePreWriteInventory(db, id, expectedVersion, acquiredReservations, [], [], []);
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
                // This legacy purpose is a durable idempotency identity. The path repairs an
                // active aggregate whose inventory projection was previously restored.
                { reservationKey: adminOrderInventoryClaimKey(id, expectedVersion, "reserve-reactivation") },
            );
            if (!reserveResult.success) {
                throw new ValidationError(reserveResult.error ?? "Insufficient stock to repair the order reservation");
            }
            acquiredReservations = newEntries;
        }

        if (existingInventoryAction === "reserved") {
            if (targetRestoresStock) {
                await releaseReservationsForOrderEdit(
                    db,
                    id,
                    expectedVersion,
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
                    expectedVersion,
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
                    expectedVersion,
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
                    expectedVersion,
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

        const committedOrderVersion = expectedVersion + 1;
        const atomicEditStatements: SQLiteBatchItem[] = [];
        if (newCustomerId) {
            atomicEditStatements.push(buildGuardedCustomerInsert(
                db,
                id,
                newCustomerId,
                data,
                totalAmount,
                expectedVersion,
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
                eq(orders.version, expectedVersion),
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

        return {
            id,
            inventoryMutationVariantIds: [...new Set([
                ...positiveEntries.map((entry) => entry.variantId),
                ...negativeEntries.map((entry) => entry.variantId),
            ])],
        };
    } catch (error) {
        if (!writesCommitted) {
            try {
                await compensatePreWriteInventory(
                    db,
                    id,
                    expectedVersion,
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
