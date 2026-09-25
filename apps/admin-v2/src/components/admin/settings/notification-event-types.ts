// The notification events each rules table lists, from the shared vocabulary.
import {
  ORDER_NOTIFICATION_TYPES,
  RESOLVED_NOTIFICATION_TYPES,
  STAFF_ALERT_NOTIFICATION_TYPES,
  adminChannelsForType,
  customerChannelsForType,
  isTemplatedNotificationType,
  type NotificationType,
  type OrderNotificationType,
  type TemplatedNotificationType,
} from "@scalius/core/modules/notifications/browser";

export {
  adminChannelsForType,
  customerChannelsForType,
  isTemplatedNotificationType,
  type NotificationType,
  type OrderNotificationType,
  type TemplatedNotificationType,
};

/**
 * Buyer messages: every order event, a staff reply in a conversation, and the
 * digital delivery, gift card and review request messages (Wave B §10).
 */
export const CUSTOMER_NOTIFICATION_TYPES: readonly NotificationType[] = [
  ...ORDER_NOTIFICATION_TYPES,
  "conversation_reply",
  ...RESOLVED_NOTIFICATION_TYPES,
];

/**
 * Staff alerts: every order event, a new customer message (warranty claim and
 * review threads included), a review waiting for approval and a licence key
 * pool running out.
 */
export const STAFF_NOTIFICATION_TYPES: readonly NotificationType[] = [
  ...ORDER_NOTIFICATION_TYPES,
  "conversation_message",
  ...STAFF_ALERT_NOTIFICATION_TYPES,
];
