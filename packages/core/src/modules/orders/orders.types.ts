// src/modules/orders/orders.types.ts
// Shared TypeScript interfaces for the orders module.

import type { OrderNotificationType } from "../notifications/notification-types";
import type {
    ActiveRefundOperationView,
    OrderRefundAttemptView,
} from "../payments/refund-attempt-visibility";
import type { OrderSupportRequestView } from "./order-support-requests";
import type { TaxQuote } from "../tax";
import type { PromotionCheckoutSnapshot } from "../promotions";

// ─────────────────────────────────────────
// Admin types
// ─────────────────────────────────────────

export interface OrderShipmentSummary {
    id: string;
    providerId: string | null;
    providerType: string | null;
    providerName: string | null;
    status: string;
    rawStatus: string | null;
    externalId: string | null;
    trackingId: string | null;
    lastChecked: Date | null;
    updatedAt: Date;
    createdAt: Date;
}

export type OrderShipmentRecoveryState =
    | "none"
    | "creating"
    | "needs_attention"
    | "failed";

export interface OrderShipmentRecoverySummary {
    state: OrderShipmentRecoveryState;
    severity: "info" | "warning" | "danger";
    activeLock: boolean;
    label: string;
    message: string | null;
    shipmentId: string | null;
    status: string | null;
    providerType: string | null;
    canRefresh: boolean;
    canRetryCreate: boolean;
    updatedAt: Date | null;
}

export interface OrderShipmentReconciliationResult {
    status: "repaired";
    orderId: string;
    shipmentId: string;
    orderStatus: string;
    shipmentStatus: string;
    orderStatusChanged: boolean;
    inventoryReconciled: boolean;
    claimCleared: boolean;
    trackingId: string | null;
    message: string;
    /** Internal cache signal; API responses must not expose this field. */
    availabilityTransitionVariantIds: string[];
}

export type OrderPaymentRecoveryState =
    | "none"
    | "awaiting_payment"
    | "processing"
    | "needs_attention";

export type OrderPaymentRecoveryFilter =
    | "recoverable"
    | Exclude<OrderPaymentRecoveryState, "none">;

export interface OrderPaymentRecoverySummary {
    state: OrderPaymentRecoveryState;
    label: string;
    message: string | null;
    gateway: string | null;
    paymentType: string | null;
    status: string | null;
    attempts: number;
    activeProcessing: boolean;
    staleProcessing: boolean;
    updatedAt: Date | null;
}

export interface AdminOrderFullEditReadiness {
    allowed: boolean;
    reason: string | null;
}

export interface OrderListItem {
    id: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    customerId: string | null;
    totalAmount: number;
    shippingCharge: number;
    discountAmount: number | null;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    fulfillmentStatus: string;
    createdAt: Date;
    updatedAt: Date;
    /** Browser-loaded CAS token for archive/restore and other list mutations. */
    version: number;
    itemCount: number;
    city: string;
    zone: string;
    area: string | null;
    cityName: string | null;
    zoneName: string | null;
    areaName: string | null;
    latestShipment: OrderShipmentSummary | null;
    shipmentRecovery: OrderShipmentRecoverySummary;
    paymentRecovery: OrderPaymentRecoverySummary;
    activeRefundOperation: ActiveRefundOperationView | null;
    fullEditReadiness: AdminOrderFullEditReadiness;
}

export interface OrderDetails extends OrderListItem {
    notes: string | null;
    shippingAddress: string;
    customerId: string | null;
    paidAmount: number | null;
    balanceDue: number | null;
    deletedAt: Date | null;
    currencyCode: string | null;
    currencyDecimalPlaces: number | null;
    subtotalAmountMinor: number | null;
    shippingAmountMinor: number | null;
    discountAmountMinor: number | null;
    taxAmountMinor: number;
    totalAmountMinor: number | null;
    taxLabel: string | null;
    pricesIncludeTax: boolean;
    /** Immutable promotion attribution captured when the order committed. */
    promotion: {
        id: string;
        revision: number;
        evaluatorVersion: number;
        method: "automatic" | "code";
        name: string;
        code: string | null;
    } | null;
    items: {
        id: string;
        productId: string;
        variantId: string | null;
        quantity: number;
        price: number;
        productName: string | null;
        productImage: string | null;
        variantLabel: string | null;
        fulfillmentStatus: string;
        unitPriceMinor: number | null;
        lineSubtotalMinor: number | null;
        discountAmountMinor: number | null;
        taxableAmountMinor: number | null;
        taxAmountMinor: number;
    }[];
    refundAttempts: OrderRefundAttemptView[];
    activeRefundOperation: ActiveRefundOperationView | null;
    supportRequests: OrderSupportRequestView[];
}

// ─────────────────────────────────────────
// Storefront types
// ─────────────────────────────────────────

export interface StorefrontOrderItem {
    cartKey?: string | null;
    productId: string;
    variantId: string;
    quantity: number;
    price: number;
    productName?: string | null;
    variantLabel?: string | null;
}

export interface CreateStorefrontOrderInput {
    checkoutRequestId: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    shippingAddress: string;
    city: string;
    zone: string;
    area: string | null;
    cityName?: string | null;
    zoneName?: string | null;
    areaName?: string | null;
    notes: string | null;
    items: StorefrontOrderItem[];
    discountAmount: number | null;
    discountCode?: string | null;
    shippingCharge: number;
    shippingMethodId?: string | null;
    paymentMethod: string;
    inventoryPool: string;
}

export interface CreateStorefrontOrderIdentity {
    orderId: string;
    checkoutToken: string;
}

export interface CreateStorefrontOrderCustomerIdentity {
    customerId: string;
    source: "authenticated";
}

export interface CreateStorefrontOrderResult {
    checkoutToken: string;
    orderId: string;
    paymentMethod: string;
    totalAmount: number;
    taxQuote: TaxQuote;
    commitPayload: StorefrontOrderCommitPayload;
}

/** Prepared, server-authoritative storefront order data committed synchronously by checkout. */
export interface StorefrontOrderCommitPayload {
    checkoutToken: string;
    /** Read-to-commit fence for catalog, delivery, tax, and checkout policy facts. */
    checkoutAuthorityRevision: number | null;
    /** Buyer-independent async work proven deliverable by the checkout authority snapshot. */
    checkoutSideEffects?: {
        orderCreatedNotification: boolean;
        metaPurchase: boolean;
    };
    /** Verified storefront account owner. Guest checkout deliberately keeps this null. */
    existingCustomer: { id: string } | null;
    orderData: {
        id: string;
        customerName: string;
        customerPhone: string;
        customerEmail: string | null;
        shippingAddress: string;
        city: string;
        zone: string;
        area: string | null;
        cityName: string | null;
        zoneName: string | null;
        areaName: string | null;
        notes: string | null;
        totalAmount: number;
        shippingCharge: number;
        discountAmount: number;
        currencyCode: string;
        currencyDecimalPlaces: number;
        subtotalAmountMinor: number;
        shippingAmountMinor: number;
        discountAmountMinor: number;
        taxAmountMinor: number;
        totalAmountMinor: number;
        taxLabel: string;
        pricesIncludeTax: boolean;
        status: string;
        paymentMethod: string;
        paymentStatus: string;
        paidAmount: number;
        balanceDue: number;
        fulfillmentStatus: string;
        inventoryPool: string;
        inventoryAction: string;
    };
    items: {
        id: string;
        taxAllocationLineId: string;
        cartKey?: string | null;
        productId: string;
        variantId: string;
        quantity: number;
        price: number;
        productName: string | null;
        variantLabel: string | null;
        inventoryTracked?: boolean;
        /** Historical image/poster Media asset selected before the order batch. */
        productImageMediaId: string | null;
        unitPriceMinor: number;
        lineSubtotalMinor: number;
        discountAmountMinor: number;
        taxableAmountMinor: number;
        taxAmountMinor: number;
    }[];
    discountUsage: { discountId: string; amountDiscounted: number } | null;
    /** Mutually exclusive with legacy discountUsage. Re-verified during the order commit. */
    promotion?: PromotionCheckoutSnapshot | null;
    requestUrl: string;
    taxQuote: TaxQuote;
}

// ─────────────────────────────────────────
// Status update types
// ─────────────────────────────────────────

export interface StatusUpdateResult {
    message: string;
    /** Internal cache signal; API responses must not expose this field. */
    availabilityTransitionVariantIds: string[];
    /** Present when the new status warrants a customer notification. */
    notification?: {
        orderId: string;
        customerEmail?: string;
        customerName: string;
        notificationType: OrderNotificationType;
        trackingId?: string;
        dedupeKey?: string;
        previousStatus?: string;
        newStatus?: string;
        version?: number;
    };
}
