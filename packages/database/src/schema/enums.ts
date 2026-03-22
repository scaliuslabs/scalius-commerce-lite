// src/db/schema/enums.ts
// Shared constant enums used across multiple domain tables.

export const OrderStatus = {
    PENDING: "pending",
    PROCESSING: "processing",
    CONFIRMED: "confirmed",
    SHIPPED: "shipped",
    DELIVERED: "delivered",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    REFUNDED: "refunded",
    RETURNED: "returned",
    PARTIALLY_REFUNDED: "partially_refunded",
    INCOMPLETE: "incomplete",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PaymentMethod = {
    STRIPE: "stripe",
    SSLCOMMERZ: "sslcommerz",
    POLAR: "polar",
    COD: "cod",
} as const;

export type PaymentMethodType = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
    UNPAID: "unpaid",
    PARTIAL: "partial",
    PAID: "paid",
    REFUNDED: "refunded",
    FAILED: "failed",
} as const;

export type PaymentStatusType = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const FulfillmentStatus = {
    PENDING: "pending",
    PARTIAL: "partial",
    COMPLETE: "complete",
} as const;

export type FulfillmentStatusType = (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

export const InventoryPool = {
    REGULAR: "regular",
    PREORDER: "preorder",
    BACKORDER: "backorder",
} as const;

export type InventoryPoolType = (typeof InventoryPool)[keyof typeof InventoryPool];

export const ItemFulfillmentStatus = {
    PENDING: "pending",
    PICKED: "picked",
    PACKED: "packed",
    SHIPPED: "shipped",
    DELIVERED: "delivered",
} as const;

export type ItemFulfillmentStatusType = (typeof ItemFulfillmentStatus)[keyof typeof ItemFulfillmentStatus];

export const DeliveryProvider = {
    PATHAO: "pathao",
    STEADFAST: "steadfast",
} as const;

export type DeliveryProviderType = (typeof DeliveryProvider)[keyof typeof DeliveryProvider];

export const DiscountType = {
    AMOUNT_OFF_PRODUCTS: "amount_off_products",
    AMOUNT_OFF_ORDER: "amount_off_order",
    FREE_SHIPPING: "free_shipping",
} as const;

export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

export const DiscountValueType = {
    PERCENTAGE: "percentage",
    FIXED_AMOUNT: "fixed_amount",
    FREE: "free",
} as const;

export type DiscountValueType = (typeof DiscountValueType)[keyof typeof DiscountValueType];

export const WidgetPlacementRule = {
    BEFORE_COLLECTION: "before_collection",
    AFTER_COLLECTION: "after_collection",
    FIXED_TOP_HOMEPAGE: "fixed_top_homepage",
    FIXED_BOTTOM_HOMEPAGE: "fixed_bottom_homepage",
    STANDALONE: "standalone",
} as const;

export type WidgetPlacementRule = (typeof WidgetPlacementRule)[keyof typeof WidgetPlacementRule];

export const PaymentRecordStatus = {
    PENDING: "pending",
    CONFIRMED: "confirmed",
    SUCCEEDED: "succeeded",
    FAILED: "failed",
    REFUNDED: "refunded",
    CANCELLED: "cancelled",
} as const;

export type PaymentRecordStatusType = (typeof PaymentRecordStatus)[keyof typeof PaymentRecordStatus];

export const CodStatus = {
    PENDING: "pending",
    COLLECTED: "collected",
    FAILED: "failed",
    RETURNED: "returned",
} as const;

export type CodStatusType = (typeof CodStatus)[keyof typeof CodStatus];

export const PaymentPlanStatus = {
    PENDING: "pending",
    DEPOSIT_PAID: "deposit_paid",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
} as const;

export type PaymentPlanStatusType = (typeof PaymentPlanStatus)[keyof typeof PaymentPlanStatus];

export const ShipmentStatus = {
    PENDING: "pending",
    PICKED_UP: "picked_up",
    IN_TRANSIT: "in_transit",
    DELIVERED: "delivered",
    RETURNED: "returned",
    CANCELLED: "cancelled",
} as const;

export type ShipmentStatusType = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

export const AlertStatus = {
    ACTIVE: "active",
    ACKNOWLEDGED: "acknowledged",
    RESOLVED: "resolved",
} as const;

export type AlertStatusType = (typeof AlertStatus)[keyof typeof AlertStatus];
