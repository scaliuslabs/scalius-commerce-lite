import {
  ORDER_NOTIFICATION_LABELS,
  ORDER_NOTIFICATION_TYPES,
  type OrderNotificationType,
} from "@scalius/core/modules/notifications/notification-types";

export const CUSTOMER_NOTIFICATION_CHANNELS = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
] as const;

export const ADMIN_NOTIFICATION_CHANNELS = [
  { key: "push", label: "Push" },
] as const;

export const NOTIFICATION_EVENTS = ORDER_NOTIFICATION_TYPES.map((key) => ({
  key,
  label: ORDER_NOTIFICATION_LABELS[key],
}));

export const NOTIFICATION_EVENT_GROUPS: ReadonlyArray<{
  label: string;
  keys: readonly OrderNotificationType[];
}> = [
  {
    label: "Order progress",
    keys: [
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
    label: "Payments & returns",
    keys: [
      "order_returned",
      "refund_processing",
      "refund_failed",
      "order_refunded",
      "order_partially_refunded",
      "payment_balance_paid",
    ],
  },
  {
    label: "Support",
    keys: ["support_request_submitted", "support_request_status_updated"],
  },
];

export type CustomerNotificationChannel =
  (typeof CUSTOMER_NOTIFICATION_CHANNELS)[number]["key"];
export type AdminNotificationChannel =
  (typeof ADMIN_NOTIFICATION_CHANNELS)[number]["key"];
export type CustomerNotificationConfig = Record<
  OrderNotificationType,
  Record<CustomerNotificationChannel, boolean>
>;
export type AdminNotificationConfig = Record<
  OrderNotificationType,
  Record<AdminNotificationChannel, boolean>
>;

export function getDefaultCustomerNotificationConfig(): CustomerNotificationConfig {
  const config = {} as CustomerNotificationConfig;
  for (const event of NOTIFICATION_EVENTS) {
    config[event.key] = {
      email: event.key !== "support_request_submitted",
      sms: false,
      whatsapp: false,
    };
  }
  return config;
}

export function getDefaultAdminNotificationConfig(): AdminNotificationConfig {
  const config = {} as AdminNotificationConfig;
  for (const event of NOTIFICATION_EVENTS) {
    config[event.key] = {
      push:
        event.key === "order_created" ||
        event.key === "order_cancelled" ||
        event.key === "support_request_submitted",
    };
  }
  return config;
}

/**
 * Provider readiness controls delivery, not merchant intent. A temporarily
 * unavailable provider must therefore leave the saved rule checked so it can
 * resume without a second settings write after the provider recovers.
 */
export function buildCustomerNotificationConfig(
  channelData: Record<string, string[]> | undefined,
): CustomerNotificationConfig {
  const config = getDefaultCustomerNotificationConfig();
  if (!channelData || typeof channelData !== "object") return config;

  for (const event of NOTIFICATION_EVENTS) {
    const enabledChannels = channelData[event.key];
    if (!Array.isArray(enabledChannels)) continue;
    for (const channel of CUSTOMER_NOTIFICATION_CHANNELS) {
      config[event.key][channel.key] = enabledChannels.includes(channel.key);
    }
  }
  return config;
}

export function buildAdminNotificationConfig(
  channelData: Record<string, string[]> | undefined,
): AdminNotificationConfig {
  const config = getDefaultAdminNotificationConfig();
  if (!channelData || typeof channelData !== "object") return config;

  for (const event of NOTIFICATION_EVENTS) {
    const enabledChannels = channelData[event.key];
    if (!Array.isArray(enabledChannels)) continue;
    config[event.key].push = enabledChannels.includes("push");
  }
  return config;
}

export function serializeCustomerNotificationConfig(
  config: CustomerNotificationConfig,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const event of NOTIFICATION_EVENTS) {
    result[event.key] = CUSTOMER_NOTIFICATION_CHANNELS
      .filter((channel) => config[event.key]?.[channel.key])
      .map((channel) => channel.key);
  }
  return result;
}

export function serializeAdminNotificationConfig(
  config: AdminNotificationConfig,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const event of NOTIFICATION_EVENTS) {
    result[event.key] = config[event.key]?.push ? ["push"] : [];
  }
  return result;
}

export function setCustomerChannelForEveryEvent(
  config: CustomerNotificationConfig,
  channel: CustomerNotificationChannel,
  enabled: boolean,
): CustomerNotificationConfig {
  const next = { ...config };
  for (const event of NOTIFICATION_EVENTS) {
    next[event.key] = { ...config[event.key], [channel]: enabled };
  }
  return next;
}

export function setAdminPushForEveryEvent(
  config: AdminNotificationConfig,
  enabled: boolean,
): AdminNotificationConfig {
  const next = { ...config };
  for (const event of NOTIFICATION_EVENTS) {
    next[event.key] = { push: enabled };
  }
  return next;
}

export function getCustomerChannelSelection(
  config: CustomerNotificationConfig,
  channel: CustomerNotificationChannel,
): boolean | "indeterminate" {
  const enabled = NOTIFICATION_EVENTS.filter(
    (event) => config[event.key]?.[channel],
  ).length;
  if (enabled === 0) return false;
  if (enabled === NOTIFICATION_EVENTS.length) return true;
  return "indeterminate";
}

export function getAdminPushSelection(
  config: AdminNotificationConfig,
): boolean | "indeterminate" {
  const enabled = NOTIFICATION_EVENTS.filter(
    (event) => config[event.key]?.push,
  ).length;
  if (enabled === 0) return false;
  if (enabled === NOTIFICATION_EVENTS.length) return true;
  return "indeterminate";
}

export function customerNotificationConfigsEqual(
  left: CustomerNotificationConfig,
  right: CustomerNotificationConfig,
): boolean {
  return (
    JSON.stringify(serializeCustomerNotificationConfig(left)) ===
    JSON.stringify(serializeCustomerNotificationConfig(right))
  );
}

export function adminNotificationConfigsEqual(
  left: AdminNotificationConfig,
  right: AdminNotificationConfig,
): boolean {
  return (
    JSON.stringify(serializeAdminNotificationConfig(left)) ===
    JSON.stringify(serializeAdminNotificationConfig(right))
  );
}
