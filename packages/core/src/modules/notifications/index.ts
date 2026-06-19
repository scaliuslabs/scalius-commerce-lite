// src/modules/notifications/index.ts
export { sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
export {
  ORDER_NOTIFICATION_LABELS,
  ORDER_NOTIFICATION_TYPES,
  isOrderNotificationType,
} from "./notification-types";
export {
  buildOrderNotificationDeliveryReceiptKey,
  claimOrderNotificationDeliveryReceipt,
  createOrderNotificationDeliveryTarget,
  createProviderClientReference,
  markOrderNotificationDeliveryReceiptAccepted,
  markOrderNotificationDeliveryReceiptFailed,
  markOrderNotificationDeliveryReceiptSkipped,
} from "./order-notification-delivery-receipts";
export {
  buildOrderCreatedNotificationDedupeKey,
  buildOrderStatusNotificationDedupeKey,
  claimOrderNotificationOutboxForProcessing,
  createOrderNotificationOutboxInsertValues,
  enqueueOrderNotificationOutboxById,
  flushPendingOrderNotificationOutbox,
  markOrderNotificationOutboxProcessingFailed,
  markOrderNotificationOutboxSent,
  recordAndEnqueueOrderNotification,
} from "./order-notification-outbox";
export type { OrderNotificationType } from "./notification-types";
export type {
  OrderNotificationDeliveryChannel,
  OrderNotificationDeliveryReceiptClaim,
  OrderNotificationDeliveryReceiptResult,
  OrderNotificationDeliveryReceiptStatus,
  OrderNotificationDeliveryTarget,
  OrderNotificationDeliveryTargetInput,
} from "./order-notification-delivery-receipts";
export type {
  OrderNotificationInput,
  OrderNotificationOutboxStatus,
  OrderNotificationQueue,
  OrderNotificationQueueMessage,
  RecordAndEnqueueOrderNotificationResult,
} from "./order-notification-outbox";
