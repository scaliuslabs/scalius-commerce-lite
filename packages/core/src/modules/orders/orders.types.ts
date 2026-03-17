// src/modules/orders/orders.types.ts
// Shared TypeScript interfaces for the orders module.

import type { Database } from "@scalius/database/client";

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
}

export interface OrderDetails extends OrderListItem {
    notes: string | null;
    shippingAddress: string;
    customerId: string | null;
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
    }[];
}

// ─────────────────────────────────────────
// Storefront types
// ─────────────────────────────────────────

export interface StorefrontOrderItem {
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
    productName?: string | null;
    variantLabel?: string | null;
}

export interface CreateStorefrontOrderInput {
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

export interface CreateStorefrontOrderResult {
    checkoutToken: string;
    orderId: string;
    paymentMethod: string;
    totalAmount: number;
    queuePayload: Record<string, unknown>;
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
        notificationType: "order_shipped" | "order_delivered";
    };
}
