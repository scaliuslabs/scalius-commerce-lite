# Notifications

Multi-channel order lifecycle notifications: email, SMS (4 providers), WhatsApp, and admin FCM push. Channel preferences are per-status configurable.

## Connection Status

| Feature | Implemented | Connected End-to-End |
|---------|-------------|---------------------|
| FCM push to admin (new order) | Yes | Yes -- called from queue consumer via `sendOrderNotification()` |
| Order email to customer | Yes | Yes -- via Cloudflare Queue with channel preference check |
| SMS to customer | Yes | Yes -- 4 providers (smsnetbd, bdbulksms, mimsms, gennet) via `getActiveSmsProvider()` |
| OTP email to customer | Yes | Yes -- via Cloudflare Queue |
| OTP via WhatsApp | Yes | Yes -- via Cloudflare Queue |
| OTP via SMS | Yes | Yes -- via same 4 SMS providers |

### FCM Push: Connected

`sendOrderNotification()` is fully implemented and connected via the queue consumer. The order notification queue handler awaits customer notification dispatch, then checks admin push channel preferences and calls `sendOrderNotification()` when push is enabled.

- Reads Firebase service account from `settings` table (category `firebase`, key `service_account`), falls back to `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` env var
- `getFirebaseAdminMessaging(env, serviceAccountJson?)` creates a new `FCMMessagingService` instance when DB credentials are provided, or returns a singleton for env-var credentials
- Uses `escapeHtml()` from `@scalius/shared/html-escape` to sanitize customer names in notification payloads

### Order Emails: Connected

The order email flow is fully connected:
1. Admin, storefront, payment, COD, or delivery webhook code commits an order lifecycle change
2. `updateOrderStatus()` returns a `notification` object with email/name/type
3. Route or queue producer enqueues `{ type: "order.notification", ... }` to `ORDER_NOTIFICATIONS_QUEUE`
4. Queue consumer (`queue-consumer.ts`) matches `order.notification` and calls `sendOrderNotificationEmail()`
5. `sendOrderNotificationEmail()` checks notification channel preferences before sending via the active email provider. Cloudflare Email is the native default, with Resend available as the external fallback.

## Functions

### `sendOrderNotification(db, order, env, requestUrl)`

Sends FCM push notifications to all active admin devices about a new order.

- Reads Firebase service account from `settings` table (category `firebase`, key `service_account`), falls back to `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` env var
- Queries all active tokens from `adminFcmTokens` table
- Builds notification payload with order ID, customer name (XSS-escaped via `escapeHtml()`), and deep link to order detail page
- Calls `FCMMessagingService.sendEachForMulticast()` with bounded concurrency. Response order is preserved, so invalid-token cleanup remains aligned with the original active-token query.
- Auto-deactivates invalid tokens (unregistered or invalid registration) in the database
- Catches all errors internally so admin push failures do not make an otherwise successful customer notification queue message retry
- All catch blocks use typed `error: unknown` with `instanceof Error` checks

### `sendOrderNotificationEmail(email, name, orderId, type, data?, db?)`

Sends transactional order emails to customers. Connected via queue.

**Channel Preference Checking**: When a `db` parameter is provided, the function checks notification channel preferences via `getNotificationChannels()` from the settings service before sending. If the email channel is disabled for the given status, the email is silently skipped. If the check fails, it defaults to sending email.

**Supported email types** (9 total):
- `order_created` -- "We've received your order"
- `order_confirmed` -- "Your order has been confirmed"
- `order_processing` -- "Your order is being processed"
- `order_shipped` -- "Your order is on its way" (includes tracking ID if provided in `data.trackingId`)
- `order_delivered` -- "Your order has been delivered"
- `order_completed` -- "Your order is complete"
- `order_cancelled` -- "Your order has been cancelled"
- `order_returned` -- "Your order return has been processed"
- `order_refunded` -- "Your refund has been processed"

Uses inline HTML templates with basic responsive styling. Customer names and tracking IDs are XSS-escaped via `escapeHtml()` from `@scalius/shared/html-escape`. Sends via the active email provider (Cloudflare Email by default, Resend fallback).

**SMS channel dispatch**: When SMS is enabled for a status, the function dynamically imports `getActiveSmsProvider()` from `@scalius/core/integrations/sms` and sends via the active provider. 4 SMS providers are supported: smsnetbd, bdbulksms, mimsms, gennet. SMS failures are caught and logged but do not affect email delivery.

**WhatsApp channel**: When WhatsApp is enabled for a status, the function logs a placeholder message. Push notifications are handled separately by `sendOrderNotification()`.

**Current provider gaps**: Email has a Cloudflare-native default and external fallback. Admin push is still Firebase-only, SMS is Bangladesh-provider-only, and order WhatsApp is channel-visible but not implemented. Keep those as explicit gaps until first-party Web Push and manual/own-channel alternatives are added.

## Queue Processing

The queue consumer (`apps/api/src/queue-consumer.ts`) handles these notification-related message types:

### `order.notification`
- Enqueued by: storefront order ingest for new orders, admin order/COD/status routes, payment/refund flows, bulk/single provider shipment creation, and delivery webhook/admin refresh status reconciliation when the committed order status maps to an existing notification type
- Handler: Calls `sendOrderNotificationEmail()` if `customerEmail` is present (with `db` for channel checking -- dispatches independently to email, SMS, WhatsApp, push), and `sendOrderNotification()` for FCM push to admin devices
- Queue: `ORDER_NOTIFICATIONS_QUEUE`
- Retry: Cloudflare auto-retry up to 3 times, 30s delay on failure
- Channel independence: each channel (email, SMS, WhatsApp, push) is dispatched independently -- failure in one does not affect others

Delivery notification enqueue is intentionally API-local because it depends on the Cloudflare Queue binding. `updateOrderStatusFromShipment()` remains a pure order/inventory transition helper and does not send queue messages itself.

### `auth.send_otp`
- Enqueued by: Customer auth flow
- Handler: Inline in queue consumer
  - `method: "email"` -- Sends OTP code via email provider
  - `method: "phone"` + `allowedMethod: "whatsapp_otp"` -- Sends OTP via WhatsApp Business API template
  - `method: "phone"` + other -- Sends OTP via active SMS provider (`getActiveSmsProvider()`)

## Files

- `index.ts` -- barrel exports: `sendOrderNotification`, `sendOrderNotificationEmail`
- `notifications.service.ts` -- both functions

## Dependencies

- `@scalius/database` -- `adminFcmTokens` table (FCM tokens), `settings` table (Firebase credentials)
- `@scalius/core/integrations/firebase/admin` -- `getFirebaseAdminMessaging()` for FCM REST API
- `@scalius/core/integrations/email` -- `sendEmail()` for transactional emails
- `@scalius/core/integrations/sms` -- `getActiveSmsProvider()` for SMS channel dispatch (4 providers: smsnetbd, bdbulksms, mimsms, gennet)
- `@scalius/core/modules/settings/settings.service` -- `getNotificationChannels()` for channel preference checking
- `@scalius/shared/html-escape` -- `escapeHtml()` for XSS prevention in notification content
