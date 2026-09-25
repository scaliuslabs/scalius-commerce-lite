// Notification vocabulary (Wave A §10). Pure: the settings document, the
// dashboard channel matrix, the outbox and the queue consumer share it.
//
// Order types are about one order and render through the order templates.
// Conversation types are about one thread: `conversation_reply` tells the
// buyer staff answered, `conversation_message` tells staff a buyer wrote.

export const ORDER_NOTIFICATION_TYPES = [
    "order_created",
    "order_confirmed",
    "order_processing",
    "order_shipped",
    "order_ready_for_pickup",
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

export const CONVERSATION_NOTIFICATION_TYPES = [
    "conversation_reply",
    "conversation_message",
] as const;

export type ConversationNotificationType = (typeof CONVERSATION_NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPES = [
    ...ORDER_NOTIFICATION_TYPES,
    ...CONVERSATION_NOTIFICATION_TYPES,
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What a notification is about; the outbox and receipts are keyed by it. */
export const NOTIFICATION_SUBJECT_TYPES = ["order", "conversation", "gift_card", "digital"] as const;
export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];

export const NOTIFICATION_AUDIENCES = ["customer", "staff"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const ORDER_NOTIFICATION_LABELS: Record<OrderNotificationType, string> = {
    order_created: "Order Created",
    order_confirmed: "Order Confirmed",
    order_processing: "Order Processing",
    order_shipped: "Order Shipped",
    order_ready_for_pickup: "Ready for Pickup",
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

export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
    ...ORDER_NOTIFICATION_LABELS,
    conversation_reply: "New Reply",
    conversation_message: "New Customer Message",
};

/**
 * The channels each type may use, by audience. Customer channels are resolved
 * against the buyer's contact at send time; admin channels reach staff (push
 * to registered devices, email to the staff recipients). WhatsApp templates
 * are order-shaped, so thread replies never use them.
 */
export const CUSTOMER_NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const ADMIN_NOTIFICATION_CHANNELS = ["push", "email"] as const;
export type CustomerNotificationChannel = (typeof CUSTOMER_NOTIFICATION_CHANNELS)[number];
export type AdminNotificationChannel = (typeof ADMIN_NOTIFICATION_CHANNELS)[number];

export function customerChannelsForType(type: NotificationType): readonly CustomerNotificationChannel[] {
    if (type === "conversation_message") return [];
    if (type === "conversation_reply") return ["email", "sms"];
    return CUSTOMER_NOTIFICATION_CHANNELS;
}

export function adminChannelsForType(type: NotificationType): readonly AdminNotificationChannel[] {
    if (type === "conversation_reply") return [];
    if (type === "conversation_message") return ADMIN_NOTIFICATION_CHANNELS;
    return ["push"];
}

export function isOrderNotificationType(value: string): value is OrderNotificationType {
    return (ORDER_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isConversationNotificationType(value: string): value is ConversationNotificationType {
    return (CONVERSATION_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isNotificationType(value: string): value is NotificationType {
    return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}
