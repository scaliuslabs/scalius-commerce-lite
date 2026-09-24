import {
  ORDER_NOTIFICATION_TYPES,
  type OrderNotificationType,
} from "@scalius/core/modules/notifications/notification-types";

export const CUSTOMER_NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;

/** Grouped for display; labels come from `notificationEventMessages`. */
export const NOTIFICATION_EVENT_GROUPS = [
  {
    key: "groupOrders",
    events: [
      "order_created",
      "order_confirmed",
      "order_processing",
      "order_shipped",
      "order_delivered",
      "order_completed",
      "order_cancelled",
    ],
  },
  {
    key: "groupPayments",
    events: [
      "order_returned",
      "refund_processing",
      "refund_failed",
      "order_refunded",
      "order_partially_refunded",
      "payment_balance_paid",
    ],
  },
  {
    key: "groupSupport",
    events: ["support_request_submitted", "support_request_status_updated"],
  },
] as const satisfies ReadonlyArray<{ key: string; events: readonly OrderNotificationType[] }>;

export type CustomerNotificationChannel = (typeof CUSTOMER_NOTIFICATION_CHANNELS)[number];
export type CustomerNotificationConfig = Record<
  OrderNotificationType,
  Record<CustomerNotificationChannel, boolean>
>;
export type AdminNotificationConfig = Record<OrderNotificationType, { push: boolean }>;

/**
 * Provider readiness controls delivery, not merchant intent. A temporarily
 * unavailable provider must therefore leave the saved rule checked so it can
 * resume without a second settings write after the provider recovers.
 */
export function buildCustomerNotificationConfig(
  channelData: Record<string, string[]> | undefined,
): CustomerNotificationConfig {
  const config = {} as CustomerNotificationConfig;
  for (const event of ORDER_NOTIFICATION_TYPES) {
    const saved = channelData?.[event];
    config[event] = {
      email: Array.isArray(saved) ? saved.includes("email") : true,
      sms: Array.isArray(saved) && saved.includes("sms"),
      whatsapp: Array.isArray(saved) && saved.includes("whatsapp"),
    };
  }
  return config;
}

export function buildAdminNotificationConfig(
  channelData: Record<string, string[]> | undefined,
): AdminNotificationConfig {
  const config = {} as AdminNotificationConfig;
  for (const event of ORDER_NOTIFICATION_TYPES) {
    const saved = channelData?.[event];
    config[event] = {
      push: Array.isArray(saved)
        ? saved.includes("push")
        : event === "order_created" || event === "order_cancelled" || event === "support_request_submitted",
    };
  }
  return config;
}

export function serializeCustomerNotificationConfig(
  config: CustomerNotificationConfig,
): Record<OrderNotificationType, CustomerNotificationChannel[]> {
  const result = {} as Record<OrderNotificationType, CustomerNotificationChannel[]>;
  for (const event of ORDER_NOTIFICATION_TYPES) {
    result[event] = CUSTOMER_NOTIFICATION_CHANNELS.filter((channel) => config[event]?.[channel]);
  }
  return result;
}

export function serializeAdminNotificationConfig(
  config: AdminNotificationConfig,
): Record<OrderNotificationType, "push"[]> {
  const result = {} as Record<OrderNotificationType, "push"[]>;
  for (const event of ORDER_NOTIFICATION_TYPES) {
    result[event] = config[event]?.push ? ["push"] : [];
  }
  return result;
}
