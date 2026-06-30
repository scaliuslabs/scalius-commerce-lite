export const ORDER_NOTIFICATION_TYPES = [
    "order_created",
    "order_confirmed",
    "order_processing",
    "order_shipped",
    "order_delivered",
    "order_completed",
    "order_cancelled",
    "order_returned",
    "refund_processing",
    "refund_failed",
    "order_refunded",
    "order_partially_refunded",
    "payment_balance_paid",
    "support_request_submitted",
    "support_request_status_updated",
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
    refund_processing: "Refund Processing",
    refund_failed: "Refund Failed",
    order_refunded: "Order Refunded",
    order_partially_refunded: "Partial Refund",
    payment_balance_paid: "Balance Paid",
    support_request_submitted: "Support Request Submitted",
    support_request_status_updated: "Support Request Updated",
};

export function isOrderNotificationType(value: string): value is OrderNotificationType {
    return (ORDER_NOTIFICATION_TYPES as readonly string[]).includes(value);
}
