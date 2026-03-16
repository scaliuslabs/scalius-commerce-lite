# Notifications

Admin push notifications (FCM) and transactional order emails.

## Files

- `index.ts` -- barrel exports
- `notifications.service.ts` -- `sendOrderNotification()` (FCM push), `sendOrderNotificationEmail()` (order lifecycle emails)

## Dependencies

- `@scalius/database` -- `adminFcmTokens`, `settings`
- `@scalius/core/integrations/firebase` -- Firebase Admin messaging
- `@scalius/core/integrations/email` -- email sending
