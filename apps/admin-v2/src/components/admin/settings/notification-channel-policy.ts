import type {
  putApiV1AdminSettingsNotificationChannels,
  putApiV1AdminSettingsNotificationChannelsAdminChannels,
} from "@scalius/api-client/sdk";
import type { ApiBody } from "~/lib/api";
import {
  CUSTOMER_NOTIFICATION_TYPES,
  STAFF_NOTIFICATION_TYPES,
  customerChannelsForType,
  adminChannelsForType,
  type NotificationType,
  type OrderNotificationType,
} from "./notification-event-types";

export const CUSTOMER_NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const ADMIN_NOTIFICATION_CHANNELS = ["push", "email"] as const;

const ORDER_EVENT_GROUPS = [
  {
    key: "groupOrders",
    events: [
      "order_created",
      "order_confirmed",
      "order_processing",
      "order_shipped",
      "order_ready_for_pickup",
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

/** The order events, grouped for display; labels come from `notificationEventMessages`. */
export const NOTIFICATION_EVENT_GROUPS = ORDER_EVENT_GROUPS;

export type NotificationEventGroup = {
  key:
    | "groupOrders"
    | "groupPayments"
    | "groupSupport"
    | "groupConversations"
    | "groupReviews"
    | "groupDigital"
    | "groupDigitalGiftCards";
  events: readonly NotificationType[];
};

/**
 * What the customer rules table lists: the order events, a reply in a
 * conversation (warranty claim and review threads included), the review
 * request, and digital delivery and gift cards.
 */
export const CUSTOMER_EVENT_GROUPS: readonly NotificationEventGroup[] = [
  ...ORDER_EVENT_GROUPS,
  { key: "groupConversations", events: ["conversation_reply"] },
  { key: "groupReviews", events: ["review_request"] },
  { key: "groupDigitalGiftCards", events: ["order_digital_delivered", "gift_card_issued", "gift_card_sent"] },
];

/**
 * What the staff rules table lists: the order events, a new customer message,
 * a review waiting for approval, and licence keys running out.
 */
export const STAFF_EVENT_GROUPS: readonly NotificationEventGroup[] = [
  ...ORDER_EVENT_GROUPS,
  { key: "groupConversations", events: ["conversation_message"] },
  { key: "groupReviews", events: ["review_pending"] },
  { key: "groupDigital", events: ["digital_keys_exhausted"] },
];

export type CustomerNotificationChannel = (typeof CUSTOMER_NOTIFICATION_CHANNELS)[number];
export type AdminNotificationChannel = (typeof ADMIN_NOTIFICATION_CHANNELS)[number];
export type CustomerNotificationConfig = Record<NotificationType, Record<CustomerNotificationChannel, boolean>>;
export type AdminNotificationConfig = Record<NotificationType, Record<AdminNotificationChannel, boolean>>;

/**
 * Whether an event can use a channel at all: replies, codes, keys and review
 * links never go by the order WhatsApp template; staff email is for customer
 * messages and the staff alerts that allow it.
 */
export function customerChannelAllowed(event: NotificationType, channel: string): boolean {
  return (customerChannelsForType(event) as readonly string[]).includes(channel);
}

export function adminChannelAllowed(event: NotificationType, channel: string): boolean {
  return (adminChannelsForType(event) as readonly string[]).includes(channel);
}

/** Mirrors core `defaultCustomerChannels` (settings/documents.ts) for an unsaved event. */
function defaultCustomerChannels(event: NotificationType): readonly string[] {
  if (event === "order_ready_for_pickup" || event === "order_digital_delivered" || event === "gift_card_issued") {
    return ["email", "sms"];
  }
  return ["email"];
}

/** Mirrors core `defaultAdminChannels` (settings/documents.ts) for an unsaved event. */
function defaultAdminChannels(event: NotificationType): readonly string[] {
  if (event === "digital_keys_exhausted") return ["push", "email"];
  return event === "order_created"
    || event === "order_cancelled"
    || event === "support_request_submitted"
    || event === "conversation_message"
    || event === "review_pending"
    ? ["push"]
    : [];
}

/**
 * Provider readiness controls delivery, not merchant intent. A temporarily
 * unavailable provider must therefore leave the saved rule checked so it can
 * resume without a second settings write after the provider recovers.
 */
export function buildCustomerNotificationConfig(
  channelData: Record<string, string[]> | undefined,
): CustomerNotificationConfig {
  const config = {} as CustomerNotificationConfig;
  for (const event of CUSTOMER_NOTIFICATION_TYPES) {
    const saved = channelData?.[event];
    const selected = Array.isArray(saved) ? saved : defaultCustomerChannels(event);
    config[event] = {
      email: selected.includes("email") && customerChannelAllowed(event, "email"),
      sms: selected.includes("sms") && customerChannelAllowed(event, "sms"),
      whatsapp: selected.includes("whatsapp") && customerChannelAllowed(event, "whatsapp"),
    };
  }
  return config;
}

export function buildAdminNotificationConfig(
  channelData: Record<string, string[]> | undefined,
): AdminNotificationConfig {
  const config = {} as AdminNotificationConfig;
  for (const event of STAFF_NOTIFICATION_TYPES) {
    const saved = channelData?.[event];
    const selected = Array.isArray(saved) ? saved : defaultAdminChannels(event);
    config[event] = {
      push: selected.includes("push") && adminChannelAllowed(event, "push"),
      email: selected.includes("email") && adminChannelAllowed(event, "email"),
    };
  }
  return config;
}

/** The saved shapes: every order event, plus the other events each audience may use. */
export type CustomerRulesBody = ApiBody<typeof putApiV1AdminSettingsNotificationChannels>["channels"];
export type AdminRulesBody = ApiBody<typeof putApiV1AdminSettingsNotificationChannelsAdminChannels>["channels"];

export function serializeCustomerNotificationConfig(config: CustomerNotificationConfig): CustomerRulesBody {
  const result: Record<string, CustomerNotificationChannel[]> = {};
  for (const event of CUSTOMER_NOTIFICATION_TYPES) {
    result[event] = CUSTOMER_NOTIFICATION_CHANNELS.filter((channel) => config[event]?.[channel] && customerChannelAllowed(event, channel));
  }
  // Each event only carries the channels it allows (checked above).
  return result as CustomerRulesBody;
}

export function serializeAdminNotificationConfig(config: AdminNotificationConfig): AdminRulesBody {
  const result: Record<string, AdminNotificationChannel[]> = {};
  for (const event of STAFF_NOTIFICATION_TYPES) {
    result[event] = ADMIN_NOTIFICATION_CHANNELS.filter((channel) => config[event]?.[channel] && adminChannelAllowed(event, channel));
  }
  return result as AdminRulesBody;
}
