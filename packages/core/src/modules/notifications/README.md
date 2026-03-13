# Notifications

Sends admin push notifications (Firebase Cloud Messaging) and transactional order emails to customers.

## Exports

- `sendOrderNotification()` — push notification to all active admin FCM tokens about a new order
- `sendOrderNotificationEmail()` — transactional email for order lifecycle events (created, confirmed, shipped, delivered)

## Dependencies

- `@scalius/database` — `adminFcmTokens`, `settings` tables
- `@scalius/core/integrations/firebase` — Firebase Admin messaging
- `@scalius/core/integrations/email` — email sending service

## API Routes

None (called internally by the queue consumer and order service).
