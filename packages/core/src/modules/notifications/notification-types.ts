export const ORDER_NOTIFICATION_TYPES = [
    "order_created",
    "order_confirmed",
    "order_processing",
    "order_shipped",
    "order_delivered",
    "order_completed",
    "order_cancelled",
    "order_returned",
    "order_refunded",
] as const;

export type OrderNotificationType = (typeof ORDER_NOTIFICATION_TYPES)[number];

export const ORDER_NOTIFICATION_LABELS: Record<OrderNotificationType, string> = {
    order_created: "Order Created",
    order_confirmed: "Order Confirmed",
    order_processing: "Order Processing",
    order_shipped: "Order Shipped",
    order_delivered: "Order Delivered",
    order_completed: "Order Completed",
    order_cancelled: "Order Cancelled",
    order_returned: "Order Returned",
    order_refunded: "Order Refunded",
};

export function isOrderNotificationType(value: string): value is OrderNotificationType {
    return (ORDER_NOTIFICATION_TYPES as readonly string[]).includes(value);
}
