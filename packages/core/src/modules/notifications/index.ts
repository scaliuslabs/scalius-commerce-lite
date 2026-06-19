// src/modules/notifications/index.ts
export { sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
export {
  ORDER_NOTIFICATION_LABELS,
  ORDER_NOTIFICATION_TYPES,
  isOrderNotificationType,
} from "./notification-types";
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
  OrderNotificationInput,
  OrderNotificationOutboxStatus,
  OrderNotificationQueue,
  OrderNotificationQueueMessage,
  RecordAndEnqueueOrderNotificationResult,
} from "./order-notification-outbox";
