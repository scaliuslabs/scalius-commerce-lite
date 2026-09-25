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

/**
 * Buyer messages whose content a domain resolves at send time (Wave B §10):
 * the API layer's `notification-content/*` resolvers return the variables, so
 * the notifications domain never imports digital, gift-cards or reviews.
 * `gift_card_issued` is about a gift card (subject `gift_card`); the others
 * are about an order.
 */
export const RESOLVED_NOTIFICATION_TYPES = [
    "order_digital_delivered",
    "gift_card_issued",
    "review_request",
] as const;

export type ResolvedNotificationType = (typeof RESOLVED_NOTIFICATION_TYPES)[number];

/** Staff alerts about an order raised by a domain, not by an order status (Wave B §10). */
export const STAFF_ALERT_NOTIFICATION_TYPES = [
    "review_pending",
    "digital_keys_exhausted",
] as const;

export type StaffAlertNotificationType = (typeof STAFF_ALERT_NOTIFICATION_TYPES)[number];

/**
 * Messages that carry a gift-card code or licence keys. Their delivery
 * receipts store no provider response, and the dispatcher scrubs the resolved
 * values from every status it records.
 */
export const CODE_BEARING_NOTIFICATION_TYPES = [
    "order_digital_delivered",
    "gift_card_issued",
] as const;

// Bundlers treat a top-level spread as a possible side effect, and one would
// keep the whole browser entry (templates, message copy) in the dashboard's
// always-loaded code; the pure initializer keeps this module tree-shakeable.
export const NOTIFICATION_TYPES = /* @__PURE__ */ (() => [
    ...ORDER_NOTIFICATION_TYPES,
    ...CONVERSATION_NOTIFICATION_TYPES,
    ...RESOLVED_NOTIFICATION_TYPES,
    ...STAFF_ALERT_NOTIFICATION_TYPES,
] as const)();

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Buyer messages rendered from a merchant-editable template (email + SMS copy). */
export const TEMPLATED_NOTIFICATION_TYPES = /* @__PURE__ */ (() => [
    ...ORDER_NOTIFICATION_TYPES,
    ...RESOLVED_NOTIFICATION_TYPES,
] as const)();

export type TemplatedNotificationType = (typeof TEMPLATED_NOTIFICATION_TYPES)[number];

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
    if (type === "conversation_message" || isStaffAlertNotificationType(type)) return [];
    // Codes, keys and review links are not in the order WhatsApp template.
    if (type === "conversation_reply" || isResolvedNotificationType(type)) return ["email", "sms"];
    return CUSTOMER_NOTIFICATION_CHANNELS;
}

export function adminChannelsForType(type: NotificationType): readonly AdminNotificationChannel[] {
    if (type === "conversation_reply" || isResolvedNotificationType(type)) return [];
    if (type === "conversation_message" || isStaffAlertNotificationType(type)) return ADMIN_NOTIFICATION_CHANNELS;
    return ["push"];
}

export function isOrderNotificationType(value: string): value is OrderNotificationType {
    return (ORDER_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isConversationNotificationType(value: string): value is ConversationNotificationType {
    return (CONVERSATION_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isResolvedNotificationType(value: string): value is ResolvedNotificationType {
    return (RESOLVED_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isStaffAlertNotificationType(value: string): value is StaffAlertNotificationType {
    return (STAFF_ALERT_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isCodeBearingNotificationType(value: string): boolean {
    return (CODE_BEARING_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isTemplatedNotificationType(value: string): value is TemplatedNotificationType {
    return (TEMPLATED_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isNotificationType(value: string): value is NotificationType {
    return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}
