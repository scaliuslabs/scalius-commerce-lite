# Notifications

Admin push notifications (FCM) and transactional order lifecycle emails with channel preference checking.

## Connection Status

| Feature | Implemented | Connected End-to-End |
|---------|-------------|---------------------|
| FCM push to admin (new order) | Yes | Yes -- called from queue consumer via `sendOrderNotification()` |
| Order email to customer | Yes | Yes -- via Cloudflare Queue with channel preference check |
| OTP email to customer | Yes | Yes -- via Cloudflare Queue |
| OTP via WhatsApp | Yes | Yes -- via Cloudflare Queue |
| OTP via SMS | No | No -- provider logic pending |

### FCM Push: Connected

`sendOrderNotification()` is fully implemented and connected via the queue consumer. The order notification queue handler calls it with `ctx.waitUntil()` for background execution.

- Reads Firebase service account from `settings` table (category `firebase`, key `service_account`), falls back to `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` env var
- `getFirebaseAdminMessaging(env, serviceAccountJson?)` creates a new `FCMMessagingService` instance when DB credentials are provided, or returns a singleton for env-var credentials
- Uses `escapeHtml()` from `@scalius/shared/html-escape` to sanitize customer names in notification payloads

### Order Emails: Connected

The order email flow is fully connected:
1. Admin updates order status via `PATCH /admin/orders/:id/status`
2. `updateOrderStatus()` returns a `notification` object with email/name/type
3. Route enqueues `{ type: "order.notification", ... }` to `ORDER_NOTIFICATIONS_QUEUE`
4. Queue consumer (`queue-consumer.ts`) matches `order.notification` and calls `sendOrderNotificationEmail()`
5. `sendOrderNotificationEmail()` checks notification channel preferences before sending via the email provider (Resend)

## Functions

### `sendOrderNotification(db, order, env, requestUrl)`

Sends FCM push notifications to all active admin devices about a new order.

- Reads Firebase service account from `settings` table (category `firebase`, key `service_account`), falls back to `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` env var
- Queries all active tokens from `adminFcmTokens` table
- Builds notification payload with order ID, customer name (XSS-escaped via `escapeHtml()`), and deep link to order detail page
- Calls `FCMMessagingService.sendEachForMulticast()` (iterates tokens sequentially)
- Auto-deactivates invalid tokens (unregistered or invalid registration) in the database
- Designed for `ctx.waitUntil()` -- catches all errors internally to prevent unhandled rejections
- All catch blocks use typed `error: unknown` with `instanceof Error` checks

### `sendOrderNotificationEmail(email, name, orderId, type, data?, db?)`

Sends transactional order emails to customers. Connected via queue.

**Channel Preference Checking**: When a `db` parameter is provided, the function checks notification channel preferences via `getNotificationChannels()` from the settings service before sending. If the email channel is disabled for the given status, the email is silently skipped. If the check fails, it defaults to sending email.

**Supported email types** (6 total):
- `order_created` -- "We've received your order"
- `order_confirmed` -- "Your order has been confirmed"
- `order_processing` -- "Your order is being processed"
- `order_shipped` -- "Your order is on its way" (includes tracking ID if provided in `data.trackingId`)
- `order_delivered` -- "Your order has been delivered"
- `order_cancelled` -- "Your order has been cancelled"

Uses inline HTML templates with basic responsive styling. Customer names and tracking IDs are XSS-escaped via `escapeHtml()` from `@scalius/shared/html-escape`. Sends via the active email provider (Resend by default).

**Future channel stubs**: When SMS or WhatsApp channels are enabled for a status, the function logs a stub message (`SMS not yet implemented`, `WhatsApp not yet implemented`). Push notifications are handled separately by `sendOrderNotification()`.

## Queue Processing

The queue consumer (`apps/api/src/queue-consumer.ts`) handles these notification-related message types:

### `order.notification`
- Enqueued by: `PATCH /admin/orders/:id/status` when status change warrants notification
- Handler: Calls `sendOrderNotificationEmail()` if `customerEmail` is present (with `db` for channel checking), and `sendOrderNotification()` for FCM push
- Queue: `ORDER_NOTIFICATIONS_QUEUE`
- Retry: Cloudflare auto-retry up to 3 times, 30s delay on failure

### `auth.send_otp`
- Enqueued by: Customer auth flow
- Handler: Inline in queue consumer
  - `method: "email"` -- Sends OTP code via email provider
  - `method: "phone"` + `allowedMethod: "whatsapp_otp"` -- Sends OTP via WhatsApp Business API template
  - `method: "phone"` + other -- Logs pending (SMS provider not implemented)

## Files

- `index.ts` -- barrel exports: `sendOrderNotification`, `sendOrderNotificationEmail`
- `notifications.service.ts` -- both functions

## Dependencies

- `@scalius/database` -- `adminFcmTokens` table (FCM tokens), `settings` table (Firebase credentials)
- `@scalius/core/integrations/firebase/admin` -- `getFirebaseAdminMessaging()` for FCM REST API
- `@scalius/core/integrations/email` -- `sendEmail()` for transactional emails
- `@scalius/core/modules/settings/settings.service` -- `getNotificationChannels()` for channel preference checking
- `@scalius/shared/html-escape` -- `escapeHtml()` for XSS prevention in notification content
