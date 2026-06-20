# Notifications

Multi-channel order lifecycle notifications: email, SMS (4 providers), WhatsApp, and admin FCM push. Channel preferences are per-status configurable.

## Connection Status

| Feature | Implemented | Connected End-to-End |
|---------|-------------|---------------------|
| FCM push to admin (new order) | Yes | Yes -- called from queue consumer via `sendOrderNotification()` |
| Order email to customer | Yes | Yes -- via Cloudflare Queue with channel preference check |
| SMS to customer | Yes | Yes -- 4 providers (smsnetbd, bdbulksms, mimsms, gennet) via `getActiveSmsProvider()` |
| Order WhatsApp to customer | Yes | Yes -- Meta Cloud API template messages via Cloudflare Queue |
| OTP email to customer | Yes | Yes -- via Cloudflare Queue |
| OTP via WhatsApp | Yes | Yes -- via Cloudflare Queue |
| OTP via SMS | Yes | Yes -- via same 4 SMS providers |

### FCM Push: Connected

`sendOrderNotification()` is fully implemented and connected via the queue consumer. The order notification queue handler awaits customer notification dispatch, then checks admin push channel preferences and calls `sendOrderNotification()` when push is enabled. When the queue message carries an `outboxId`, each active FCM token is guarded by an `order_notification_delivery_receipts` row so retries skip tokens already accepted by FCM.

- Reads Firebase service account from `settings` table (category `firebase`, key `service_account`) through the Firebase settings helper. New rows are encrypted `enc:` AES-GCM values, legacy plaintext rows remain read-compatible, and unreadable ciphertext falls back to `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` instead of being passed to FCM.
- `getFirebaseAdminMessaging(env, serviceAccountJson?)` creates a new `FCMMessagingService` instance when DB credentials are provided, or returns a singleton for env-var credentials
- Uses `escapeHtml()` from `@scalius/shared/html-escape` to sanitize customer names in notification payloads
- Stores FCM REST message `name` values on accepted delivery receipts; invalid/stale tokens become skipped receipts before deactivation, including Firebase variants surfaced as `Device unregistered` or `NotRegistered`

### Order Emails: Connected

The order email flow is fully connected:
1. Admin, storefront, payment, COD, or delivery webhook code commits an order lifecycle change
2. `updateOrderStatus()` returns a `notification` object with email/name/type
3. Route or queue producer enqueues `{ type: "order.notification", ... }` to `ORDER_NOTIFICATIONS_QUEUE`
4. Queue consumer (`queue-consumer.ts`) matches `order.notification` and calls `sendOrderNotificationEmail()`
5. `sendOrderNotificationEmail()` checks notification channel preferences before sending via enabled customer providers. Cloudflare Email is the native default, with Resend available as the external fallback.
6. When the queue message carries `outboxId`, customer email/SMS/WhatsApp targets create deterministic delivery receipts before provider work. Accepted/skipped receipts are terminal and are not resent on queue/outbox retry.

## Functions

### `sendOrderNotification(db, order, env, requestUrl, options?)`

Sends FCM push notifications to all active admin devices about a new order.

- Reads Firebase service account from `settings` table (category `firebase`, key `service_account`) with `CREDENTIAL_ENCRYPTION_KEY`/legacy `JWT_SECRET` read tolerance, then falls back to `FIREBASE_SERVICE_ACCOUNT_CRED_JSON` env var
- Queries all active tokens from `adminFcmTokens` table
- Builds notification payload with order ID, customer name (XSS-escaped via `escapeHtml()`), and deep link to order detail page
- Calls `FCMMessagingService.sendEachForMulticast()` with bounded concurrency. Response order is preserved, so invalid-token cleanup remains aligned with the original active-token query.
- Auto-deactivates invalid tokens (unregistered, invalid registration, or Firebase stale-device variants such as `Device unregistered`/`NotRegistered`) in the database. In receipt mode, deactivation happens only after the skipped receipt is successfully terminal.
- Returns per-target outcomes; receipt-mode retryable failures keep the parent outbox retryable instead of marking it sent
- All catch blocks use typed `error: unknown` with `instanceof Error` checks

### `sendOrderNotificationEmail(email, name, orderId, type, data?, db?, options?)`

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

Uses inline HTML templates with basic responsive styling. Customer names and tracking IDs are XSS-escaped via `escapeHtml()` from `@scalius/shared/html-escape`. Sends via the active email provider (Cloudflare Email by default, Resend fallback). Receipt-mode email sends pass the deterministic receipt key to Resend as `Idempotency-Key`; Cloudflare Email returns `messageId`, which is stored on the receipt.

**SMS channel dispatch**: When SMS is enabled for a status, the function dynamically imports `getActiveSmsProvider()` from `@scalius/core/integrations/sms` and sends via the active provider. 4 SMS providers are supported: smsnetbd, bdbulksms, mimsms, gennet. Receipt-mode SMS stores provider refs; GenNet receives a deterministic receipt-derived `csms_id` so provider retries can dedupe.

**WhatsApp channel dispatch**: When WhatsApp is enabled for a status, the function reads the order's normalized `customerPhone`, resolves the shared encrypted Meta Cloud API credentials from `settings.whatsapp/access_token` with legacy plaintext fallback, reads the order template settings from `settings.notifications`, and sends a template message through `sendWhatsAppTemplateMessage()`. Reads may use the tolerant credential key for old rows, but migration/legacy cleanup is gated by the dedicated `migrationEncryptionKey` passed from the API queue consumer. The reusable order template receives 4 body variables: customer name, order ID, order status label, and tracking ID or `-`. Missing/invalid order phones, missing Meta credentials, paused templates, and non-retryable provider validation errors become skipped receipts; malformed 200 responses, 5xx, 408/409/429, and network failures remain retryable.

**Current provider gaps**: Email has a Cloudflare-native default and external fallback. Admin push is still Firebase-only, SMS is Bangladesh-provider-only, and Meta WhatsApp has no first-class upstream idempotency key; local D1 receipts fence retries but a Worker crash after provider acceptance and before receipt persistence can still duplicate on Meta.

## Queue Processing

The queue consumer (`apps/api/src/queue-consumer.ts`) handles these notification-related message types:

### `order.notification`
- Enqueued by: storefront order ingest for new orders, admin order/COD/status routes, payment/refund flows, bulk/single provider shipment creation, and delivery webhook/admin refresh status reconciliation when the committed order status maps to an existing notification type
- Handler: Calls `sendOrderNotificationEmail()` with `db` for channel checking and delivery receipts, and `sendOrderNotification()` for FCM push to admin devices when push is enabled
- Queue: `ORDER_NOTIFICATIONS_QUEUE`
- Retry: Cloudflare auto-retry up to 3 times, 30s delay on failure
- Channel receipts: email, SMS, WhatsApp, and FCM push create one receipt per logical target. Accepted/skipped receipts are terminal; retryable failures keep the parent outbox retryable.

Delivery notification enqueue is intentionally API-local because it depends on the Cloudflare Queue binding. `updateOrderStatusFromShipment()` remains a pure order/inventory transition helper and does not send queue messages itself.

### `auth.send_otp`
- Enqueued by: Customer auth flow
- Handler: Inline in queue consumer
  - Claims `auth_otp_delivery_receipts` by `deliveryKey` before provider work
  - Skips already accepted/delivered/skipped receipts and marks expired OTP attempts as skipped instead of sending stale codes
  - `method: "email"` -- Sends OTP code via email provider. Resend receives `deliveryKey` as `Idempotency-Key`; Cloudflare Email stores the returned `messageId`.
  - `method: "phone"` + `allowedMethod: "whatsapp_otp"` -- Sends OTP via WhatsApp Business API template and stores Meta message IDs when returned
  - `method: "phone"` + other -- Sends OTP via active SMS provider (`getActiveSmsProvider()`); GenNet receives a deterministic receipt-derived client reference as `csms_id`

## Files

- `index.ts` -- barrel exports: `sendOrderNotification`, `sendOrderNotificationEmail`
- `notifications.service.ts` -- both functions
- `order-notification-outbox.ts` -- parent queue handoff/replay state
- `order-notification-delivery-receipts.ts` -- per-channel receipt claims and accepted/failed/skipped marks
- `../customers/otp-delivery-receipts.ts` -- customer OTP receipt claims and provider idempotency helper

## Dependencies

- `@scalius/database` -- `adminFcmTokens` table (FCM tokens), `settings` table (Firebase credentials), `authOtpDeliveryReceipts` table (customer OTP delivery fencing)
- `@scalius/core/integrations/firebase/admin` -- `getFirebaseAdminMessaging()` for FCM REST API
- `@scalius/core/integrations/email` -- `sendEmail()` for transactional emails
- `@scalius/core/integrations/sms` -- `getActiveSmsProvider()` for SMS channel dispatch (4 providers: smsnetbd, bdbulksms, mimsms, gennet)
- `@scalius/core/integrations/whatsapp` -- encrypted Meta Cloud API credential resolver and template sender for order/customer WhatsApp notifications
- `@scalius/core/modules/settings/settings.service` -- `getNotificationChannels()`, `getOrderWhatsAppTemplateSettings()`, and `isWhatsAppCloudApiConfigured()`
- `@scalius/shared/html-escape` -- `escapeHtml()` for XSS prevention in notification content
