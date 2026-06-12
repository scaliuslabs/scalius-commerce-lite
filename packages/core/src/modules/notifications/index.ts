// src/modules/notifications/index.ts
export { sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
export {
  ORDER_NOTIFICATION_LABELS,
  ORDER_NOTIFICATION_TYPES,
  isOrderNotificationType,
} from "./notification-types";
export type { OrderNotificationType } from "./notification-types";
