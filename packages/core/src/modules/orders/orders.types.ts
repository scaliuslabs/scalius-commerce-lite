// src/modules/orders/orders.types.ts
// Shared TypeScript interfaces for the orders module.

import type { OrderNotificationType } from "../notifications/notification-types";
import type {
    ActiveRefundOperationView,
    OrderRefundAttemptView,
} from "../payments/refund-attempt-visibility";
import type { OrderSupportRequestView } from "./order-support-requests";

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
}

export interface OrderDetails extends OrderListItem {
    notes: string | null;
    shippingAddress: string;
    customerId: string | null;
    paidAmount: number | null;
    balanceDue: number | null;
    deletedAt: Date | null;
    items: {
        id: string;
        productId: string;
        variantId: string | null;
        quantity: number;
        price: number;
        productName: string | null;
        productImage: string | null;
        variantSize: string | null;
        variantColor: string | null;
        fulfillmentStatus: string;
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
    variantId: string | null;
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
    commitPayload: StorefrontOrderCommitPayload;
}

/** Prepared, server-authoritative storefront order data committed synchronously by checkout. */
export interface StorefrontOrderCommitPayload {
    checkoutToken: string;
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
        cartKey?: string | null;
        productId: string;
        variantId: string | null;
        quantity: number;
        price: number;
        productName: string | null;
        variantLabel: string | null;
        inventoryTracked?: boolean;
    }[];
    discountUsage: { discountId: string; amountDiscounted: number } | null;
    requestUrl: string;
}

// ─────────────────────────────────────────
// Status update types
// ─────────────────────────────────────────

export interface StatusUpdateResult {
    message: string;
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
