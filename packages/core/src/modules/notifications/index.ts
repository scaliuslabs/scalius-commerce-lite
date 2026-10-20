export * from "./browser";
export * from "./documents";
export * from "./channel-settings";
export * from "./web-push";
export { sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
export {
  buildNotificationOutboxInsert,
  claimNotificationOutboxForProcessing,
  createNotificationOutboxInsertValues,
  listDueNotificationOutbox,
  notificationOutboxDueProbes,
  markNotificationOutboxDeadLettered,
  markNotificationOutboxProcessingFailed,
  markNotificationOutboxSent,
  parseNotificationPayload,
  recordAndSendNotification,
  sanitizeNotificationData,
  serializeNotificationPayload,
} from "./notification-outbox";
export type {
  ClaimedNotificationOutbox,
  NotificationData,
  NotificationInput,
  NotificationOutboxStatus,
  NotificationPayload,
  NotificationSender,
  RecordNotificationResult,
} from "./notification-outbox";
export {
  buildClearNotificationProviderBlocksStatement,
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
  orderCreatedNotificationOutboxId,
  buildOrderReadyForPickupNotificationDedupeKey,
  buildManualOrderNotificationResendDedupeKey,
  buildOrderStatusNotificationDedupeKey,
  buildSupportRequestStatusUpdatedNotificationDedupeKey,
  buildSupportRequestSubmittedNotificationDedupeKey,
  createOrderNotificationOutboxInsertValues,
  listOrderNotificationOutboxForOrder,
  recordAndSendOrderNotification,
  resendTerminalOrderNotificationOutboxById,
  retryFailedOrderNotificationOutboxById,
} from "./order-notification-outbox";
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
} from "./order-notification-outbox";
export { sendStaffOrderEmails } from "./notifications.service";
// The dispatch kit other senders build on (customer marketing): a delivery
// receipt per recipient and channel, provider pauses, and the result shape.
export {
  buildDispatchResult,
  dispatchWithReceipt,
  emailResultToDeliveryResult,
  maskEmail,
  recordProviderBlockedDeliveryIfNeeded,
  recordSkippedDelivery,
  type OrderNotificationDispatchResult,
} from "./notifications.service";
export { composeAuthOtpMessage, readStoreIdentity, readStoreName } from "./store-messages";
export { describeNotificationProviderBlock } from "./notification-provider-health";
export { getNotificationTemplates, saveNotificationTemplate } from "./notification-templates.service";
export {
  CONVERSATION_SMS_COALESCE_SECONDS,
  CONVERSATION_SMS_COALESCED,
  renderConversationEmail,
  sendConversationNotification,
} from "./conversation-notifications";
export type {
  ConversationNotificationClaim,
  ConversationNotificationResult,
} from "./conversation-notifications";
export { sendAdminPush, sendAdminPushNotice, resolveDashboardLink, type AdminPushSpec } from "./notifications.service";
export { sendWebhookDisabledNotice } from "./system-notices";
export {
  NOTHING_TO_SEND,
  recordNothingToSend,
  sendResolvedNotification,
  sendStaffAlertNotification,
} from "./resolved-notifications";
export type {
  NotificationExtraTemplateData,
  ResolvedNotificationOptions,
  ResolvedNotificationRecipient,
  ResolvedNotificationSend,
} from "./resolved-notifications";

export * from "./staff-alerts.contract";
export {
  recordStaffAlert, readStaffAlerts, readStaffAlertSummary, markStaffAlertRead,
  markAllStaffAlertsRead, clearStaffAlerts, undoStaffAlertsClear, pruneStaffAlerts,
} from "./staff-alerts";
