// src/modules/orders/types.ts
// Shared TypeScript interfaces for the orders module.

import type { OrderNotificationType } from "../notifications/notification-types";
import type { ActiveRefundOperationView, OrderRefundAttemptView } from "../payments/refund-attempt-views";
import type { TaxQuote } from "../tax/types";
import type { PromotionCheckoutSnapshot } from "../promotions/checkout-snapshot";
import type { CustomerRequestType } from "../settings/customer-request-policy.shared";

export interface OrderSupportRequestView {
    id: string;
    orderId: string;
    customerId: string | null;
    type: CustomerRequestType;
    status: string;
    active: boolean;
    severity: "info" | "success" | "warning" | "danger";
    label: string;
    actionLabel: string;
    reason: string;
    message: string | null;
    returnId: string | null;
    submittedAt: string | null;
    resolvedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

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

/** Why a shipment needs attention, as a stable code the dashboard words in its own language. */
export const ORDER_SHIPMENT_RECOVERY_REASONS = [
    "none",
    "courier_unconfirmed",
    "reconcile_required",
    "creating",
    "claim_expired",
    "failed",
] as const;
export type OrderShipmentRecoveryReason = (typeof ORDER_SHIPMENT_RECOVERY_REASONS)[number];

export interface OrderShipmentRecoverySummary {
    state: OrderShipmentRecoveryState;
    reason: OrderShipmentRecoveryReason;
    severity: "info" | "warning" | "danger";
    activeLock: boolean;
    label: string;
    message: string | null;
    shipmentId: string | null;
    status: string | null;
    providerType: string | null;
    canRefresh: boolean;
    canRetryCreate: boolean;
    canRepair: boolean;
    unknownOutcome: boolean;
    updatedAt: Date | null;
}

export type UnknownShipmentResolutionResult =
    | (OrderShipmentReconciliationResult & {
        resolution: "provider_confirmed_existing" | "merchant_confirmed_existing";
    })
    | {
        status: "released";
        resolution: "merchant_confirmed_not_created" | "merchant_confirmed_cancelled";
        orderId: string;
        shipmentId: string;
        claimCleared: true;
        orderVersion: number;
        message: string;
    };

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

/** Why part of an order can no longer be edited; the dashboard words each one. */
export type OrderEditLockReason =
    | "shipped"
    | "closed"
    | "paid"
    | "online_payment"
    | "discount"
    | "history"
    | "inventory"
    | "archived"
    | "busy"
    | "unavailable";

export interface OrderEditReadiness {
    /** Products, quantities, discount and delivery charge (quote-backed amendment). */
    items: { allowed: boolean; reason: OrderEditLockReason | null };
    /** Customer name, phone, email and delivery address. */
    details: { allowed: boolean; reason: OrderEditLockReason | null };
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
    paidAmount: number;
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
    /** Sequential store number, shown as "#1001". */
    orderNumber: number | null;
    archivedAt: Date | null;
    /** The open customer request, so it isn't shipped unnoticed. */
    openRequestType: "cancel_pre_shipment" | "return" | "refund" | null;
    cod: { status: string; deliveryAttempts: number } | null;
    /** Value of received returns not yet given back (major units). */
    refundDue: number;
    refundedAmount: number;
}

export interface OrderDetails extends OrderListItem {
    editReadiness: OrderEditReadiness;
    notes: string | null;
    shippingAddress: string;
    customerId: string | null;
    /** The customer record the order is filed under; its title can differ from the order's own name. */
    customerRecord: { id: string; name: string; phone: string; kind: "account" | "guest" | "merchant" } | null;
    balanceDue: number | null;
    deletedAt: Date | null;
    currencyCode: string | null;
    currencyDecimalPlaces: number | null;
    subtotalAmountMinor: number | null;
    shippingAmountMinor: number | null;
    shippingMethodId: string | null;
    shippingMethodName: string | null;
    shippingMethodDescription: string | null;
    shippingMethodBaseAmountMinor: number | null;
    shippingFeeWaived: boolean | null;
    discountAmountMinor: number | null;
    taxAmountMinor: number;
    totalAmountMinor: number | null;
    taxLabel: string | null;
    pricesIncludeTax: boolean;
    /** Every discount applied at checkout, one entry per promotion (major units). */
    discounts: Array<{
        promotionId: string;
        name: string;
        code: string | null;
        method: "automatic" | "code";
        amount: number;
    }>;
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
        /** Units already handed to a courier (a line can be sent in parts). */
        shippedQuantity: number;
        /** Stock is tracked for this line (cancel/return restock counts only these). */
        inventoryTracked: boolean;
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
    expectedQuoteFingerprint: string;
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
    /** Discount codes the buyer applied; each must still apply at commit. */
    discountCodes: string[];
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
    taxQuote: TaxQuote;
    commitPayload: StorefrontOrderCommitPayload;
}

/** Immutable buyer-reviewed delivery method facts captured for a storefront order. */
export interface StorefrontOrderShippingMethodSnapshot {
    id: string;
    name: string;
    description: string | null;
    /** Configured method fee before any product-level delivery waiver. */
    baseAmountMinor: number;
    feeWaived: boolean;
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
        shippingMethodId: string;
        shippingMethodName: string;
        shippingMethodDescription: string | null;
        shippingMethodBaseAmountMinor: number;
        shippingFeeWaived: boolean;
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
        paidAmountMinor: number;
        balanceDueMinor: number;
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
    /** The applied discount (code or automatic); re-verified during the order commit. */
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
