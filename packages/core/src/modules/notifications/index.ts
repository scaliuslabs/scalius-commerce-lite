// src/modules/notifications/index.ts
export { sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
export {
  ORDER_NOTIFICATION_LABELS,
  ORDER_NOTIFICATION_TYPES,
  isOrderNotificationType,
} from "./notification-types";
export {
  clearNotificationProviderBlocks,
  getNotificationProviderBlock,
  isNotificationProviderBreakerFailure,
  markNotificationProviderBlocked,
} from "./notification-provider-health";
export type {
  NotificationProviderBlock,
  NotificationProviderHealthChannel,
} from "./notification-provider-health";
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
  buildOrderBalancePaidNotificationDedupeKey,
  buildOrderCreatedNotificationDedupeKey,
  buildOrderStatusNotificationDedupeKey,
  buildSupportRequestStatusUpdatedNotificationDedupeKey,
  buildSupportRequestSubmittedNotificationDedupeKey,
  claimOrderNotificationOutboxForProcessing,
  createOrderNotificationOutboxInsertValues,
  enqueueOrderNotificationOutboxById,
  flushPendingOrderNotificationOutbox,
  listOrderNotificationOutboxForOrder,
  markOrderNotificationOutboxDeadLettered,
  markOrderNotificationOutboxProcessingFailed,
  markOrderNotificationOutboxSent,
  recordAndEnqueueOrderNotification,
  retryFailedOrderNotificationOutboxById,
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
  OrderNotificationDeliveryReceiptView,
  OrderNotificationOutboxView,
  OrderNotificationOutboxStatus,
  OrderNotificationQueue,
  OrderNotificationQueueMessage,
  RecordAndEnqueueOrderNotificationResult,
} from "./order-notification-outbox";
