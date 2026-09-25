// The notification events each rules table lists, from the shared vocabulary.
import {
  ORDER_NOTIFICATION_TYPES,
  adminChannelsForType,
  customerChannelsForType,
  type NotificationType,
  type OrderNotificationType,
} from "@scalius/core/modules/notifications/browser";

export { adminChannelsForType, customerChannelsForType, type NotificationType, type OrderNotificationType };

/** Buyer messages: every order event plus a staff reply in a conversation. */
export const CUSTOMER_NOTIFICATION_TYPES: readonly NotificationType[] = [...ORDER_NOTIFICATION_TYPES, "conversation_reply"];

/** Staff alerts: every order event plus a new customer message. */
export const STAFF_NOTIFICATION_TYPES: readonly NotificationType[] = [...ORDER_NOTIFICATION_TYPES, "conversation_message"];
