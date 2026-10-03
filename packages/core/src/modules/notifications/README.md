# Notifications

The notifications domain sends buyer and staff messages over email, SMS, WhatsApp and admin push. It owns the outbox, the delivery receipts, the channel rules, the message templates and the provider pause markers. This document is for contributors and operators.

## Where it fits

- Layer L5. Imports from other domains: `delivery`, `order-kernel`, `platform`, `settings` (`scripts/core-domain-graph.allow.json`).
- `index.ts` is the server API. `browser.ts` is the closed browser entry: `notification-types.ts`, `message-copy.ts` and `notification-templates.ts` (pure, no database).
- Provider clients are not here. They live in `packages/core/src/integrations/`: `email`, `sms`, `whatsapp.ts`, `firebase`, plus `provider-port.ts`.
- Message content from the digital, gift-cards and reviews domains is not imported. The API resolves it at send time (`apps/api/src/notification-content/*`).
- OTP codes and challenges belong to the customers domain ([README](../customers/README.md)). This domain only supplies the message copy and the provider pause markers.

## Channels and providers

| Channel | Audience | Provider | Credentials (settings document) | Readiness check |
|---|---|---|---|---|
| Email | buyer, staff | Cloudflare Email Service (default, `EMAIL` binding), Resend, or an app provider | `email` | `getEmailProviderReadiness` |
| SMS | buyer | `smsnetbd`, `bdbulksms`, `mimsms`, `gennet`, or an app provider | `sms` | `getSmsProviderReadiness` |
| WhatsApp | buyer | Meta Cloud API template message | `whatsapp` | `isWhatsAppCloudApiConfigured` |
| Push | staff | Firebase Cloud Messaging | `firebase` | `getFirebaseServiceAccountReadiness` |

- Email and SMS are provider ports. A saved choice `<plugin id>:<provider id>` names an app provider. Core asks the API's `AppProviders` lookup only for that case. See `provider-port.ts` and [Plugins](../plugins/README.md).
- Without a lookup, an app choice is not ready and nothing is sent. WhatsApp and push are not ports.
- An app answer `retryable: false` ends the receipt as skipped. An uncertain retryable failure is retried only when the message has an idempotency key (`apps/api/src/plugins/providers/messaging.ts`).
- Credentials use strict reads with `CREDENTIAL_ENCRYPTION_KEY`. Never fall back to a JWT secret. Unreadable ciphertext counts as not configured. SMS and WhatsApp also treat placeholder values (`dummy`, `example`, `changeme`, `your-token-here`, repeated digits) as not configured.
- Setup docs: [email](../../integrations/email/README.md), [Firebase](../../integrations/firebase/README.md), [WhatsApp and Meta](../../integrations/meta/README.md).

## Notification types

`notification-types.ts` is the source of truth.

| Group | Types | Buyer channels | Staff channels |
|---|---|---|---|
| Order (`ORDER_NOTIFICATION_TYPES`, 16) | `order_created`, `order_confirmed`, `order_processing`, `order_shipped`, `order_ready_for_pickup`, `order_delivered`, `order_completed`, `order_cancelled`, `order_returned`, `refund_processing`, `refund_failed`, `order_refunded`, `order_partially_refunded`, `payment_balance_paid`, `support_request_submitted`, `support_request_status_updated` | email, sms, whatsapp | push |
| Conversation | `conversation_reply` (to the buyer), `conversation_message` (to staff) | reply: email, sms | message: push, email |
| Resolved (4) | `order_digital_delivered`, `gift_card_issued`, `gift_card_sent`, `review_request` | email, sms | none |
| Staff alert | `review_pending`, `digital_keys_exhausted` | none | push, email |

- `marketing_opt_in` (double opt-in email) is a buyer flow, not a merchant choice. It is not in `NOTIFICATION_TYPES`.
- Buyer defaults: email for every buyer type. `order_ready_for_pickup`, `order_digital_delivered` and `gift_card_issued` also use SMS. WhatsApp is never a default.
- Staff defaults: push for `order_created`, `order_cancelled`, `support_request_submitted`, `conversation_message` and `review_pending`. Push and email for `digital_keys_exhausted`.
- Support notification payloads carry only the order id, request id, request type and status. Free-form customer text stays out of provider payloads.
- Status changes enqueue a notification only for shipped, delivered, cancelled, returned and refunded orders (`getOrderNotificationTypeForStatus` in `apps/api/src/utils/order-notification-queue.ts`). Other flows (checkout, refunds, pickup, support, fulfilment, reviews) write their own rows.

## Settings

| Document | Contents | Defined in |
|---|---|---|
| `notifications` | `orderChannels`, `adminChannels` (event -> channels), `staffEmailRecipients` (at most 10), `whatsappOrderTemplateName` (default `order_status_update`), `whatsappOrderTemplateLanguage` (default `en_US`) | `documents.ts` |
| `notification_templates` | Only the email subject/body and SMS body the merchant changed | `documents.ts` |

- Both use `defineSettingsDocument()`. A save sends `expectedRevision`. A stale revision returns 409.
- `channel-settings.ts` saves the rules. A channel can be newly enabled only while its provider is ready and not paused. The dashboard disables the checkbox of an unready channel (a rule that is already on can still be switched off) and shows a notice. The backend refuses a stale client that enables it.
- Provider pause markers are not documents. They are `settings` rows with category `notification_provider_health` and key `<channel>:<provider>`.

## Admin routes

All paths start with `/api/v1/admin`.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /settings/notification-channels` | `settings.general.view` | Rules, WhatsApp order template, readiness per channel, revision |
| `PUT /settings/notification-channels` | `settings.notifications.edit` | Save buyer rules and the order template |
| `PUT /settings/notification-channels/admin-channels` | `settings.notifications.edit` | Save staff rules and recipients |
| `GET /settings/notification-channels/templates` | `settings.general.view` | Templates in effect, store preview data |
| `PUT /settings/notification-channels/templates` | `settings.notifications.edit` | Save one event's templates |
| `POST /settings/notification-channels/templates/test` | `settings.notifications.edit` | Send a draft with sample data (email to the caller, SMS to a number). Rate limit `RL_STRICT`. |
| `GET`, `POST /settings/sms` | `settings.general.view`, `settings.notifications.edit` | SMS provider settings |
| `POST /settings/auth` | `settings.general.edit` | Customer sign-in policy and WhatsApp credentials |
| `GET /orders/{id}/notifications` | `orders.view` | Newest 20 outbox rows with receipts |
| `POST /orders/{id}/notifications/{outboxId}/retry` | `orders.edit` | Retry a `pending`, `failed` or `dead_lettered` row |
| `POST /orders/{id}/notifications/{outboxId}/resend` | `orders.edit` | Resend a `sent` row as a new row |

- Resend needs a request id: the `Idempotency-Key` header or `resendRequestId`. Its dedupe key is `manual_resend:<outboxId>:<resendRequestId>`.
- Retry resets the pending and failed receipts and enqueues the same row. Accepted and skipped receipts stay terminal, so nothing is sent twice.
- Email, Firebase and push-token routes are in the integration READMEs.

## Delivery pipeline

```text
fact commits
  -> notification_outbox row (pending), same batch as the fact or right after
  -> JOBS_QUEUE { type: "notification", outboxId }
  -> queue consumer claims the row, reads recipient and text now
  -> one notification_delivery_receipts row per channel and recipient
  -> provider call -> receipt accepted | skipped | failed
  -> outbox row sent | failed (backoff) | dead_lettered
```

- Table `notification_outbox` (migration 0086; migration 0108 added the `customer` subject). Subjects: `order`, `conversation`, `gift_card`, `digital`, `customer`. The consumer dispatches `order`, `gift_card`, `customer` (`marketing_opt_in` only) and `conversation`. Any other subject is dead-lettered as unsupported.
- The row and the queue message carry ids only. `sanitizeNotificationData` keeps at most 12 short primitive facts and drops keys that look like a contact, text, code or token. Nothing resolved at send time is persisted.
- `dedupe_key` is unique. Examples: `order_created:<orderId>`, `payment_balance_paid:<orderId>`, `support_request:<requestId>:submitted`, `order:<orderId>:pickup_ready:<version>`.
- Row states: `pending`, `enqueueing`, `queued`, `processing`, `sent`, `failed`, `dead_lettered`. Leases: 5 minutes to enqueue, 15 minutes to process. Each enqueue claim and each processing claim adds one attempt. At 8 attempts the row becomes `dead_lettered`.
- Backoff is `60 s x 2^(attempts-1)`, at most 1 hour. A failed delivery marks the row `failed` and acks the queue message. The scheduled flush is the retry authority. Only a legacy `order.notification` message without an `outboxId` still uses Cloudflare retries.
- `notification_outbox_flush` runs on every cron tick (every 15 minutes) on both plans. It sends due rows, rows with an expired lease and `queued` rows older than 1 hour (`STALE_QUEUED_REPLAY_SECONDS`).
  - Limit per run: 200 on Paid, 40 on Free (`ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT` x plan scale). It sends in chunks of 50 with `sendBatch` and logs `staleQueued`.
  - The `order.auto_fulfil` handler also flushes up to 50 rows at once.
- `NotificationInput.notBefore` schedules a row. It becomes `next_attempt_at`.
- `jobs-dlq` marks the row `dead_lettered`. It never resends.

## Delivery receipts

- Table `notification_delivery_receipts`. `receipt_key` is `<outboxId>:<channel>:<sha256 of the lowercase recipient>`. The table stores only the hash and a masked recipient.
- States: `pending`, `processing` (15-minute lease), `accepted`, `delivered`, `skipped`, `failed`. `accepted`, `delivered` and `skipped` are terminal. A claim skips terminal receipts.
- A retryable failure waits with the same backoff. At 8 attempts (`MAX_ORDER_NOTIFICATION_DELIVERY_ATTEMPTS`) the receipt becomes `skipped` with `delivery_attempt_limit_reached`.
- Provider idempotency: Resend gets the receipt key as `Idempotency-Key`. Cloudflare Email returns a `messageId`. GenNet gets a 20-character receipt-derived `csms_id`. Meta WhatsApp has no idempotency key. A Worker crash after Meta accepts and before the receipt write can send twice.
- Code-bearing types (`order_digital_delivered`, `gift_card_issued`) store no `raw_response`. The dispatcher removes the resolved values from every status and error it records.
- Receipt reasons: `notification_turned_off` (every buyer channel is off), `nothing_to_send` (a resolver found nothing), `missing_email_recipient`, `missing_sms_recipient`, `missing_whatsapp_recipient`, `invalid_whatsapp_recipient`, `conversation_sms_coalesced`, and the prefix `provider_blocked_until_settings_save:`.

## Failures and provider pause

- Setup and recipient failures are not retried. They end as `skipped` receipts: no provider, undecryptable or invalid credentials, authorization errors, rejected sender or template, exhausted balance, a bad Firebase service account.
- Transient failures stay `failed` and retry: timeouts, network errors, HTTP 408, 409, 429 and 5xx (SMS also treats 425 as transient).
- A setup failure also writes a pause marker for that channel and provider. Later sends skip the provider until the merchant saves its settings.
- Each settings save clears the markers of its channel in the same batch: email, SMS, WhatsApp (credentials or order template) and push (service account change).
- If a marker is missing, `notification-provider-health.ts` rebuilds the pause from the 25 newest skipped or failed receipts. It ignores evidence older than the latest save of the channel's settings.
- Marker reasons are masked (emails and phone numbers replaced) and cut to 240 characters.
- Provider failures log masked metadata only (`compactProviderLogDetail`). Never log OTPs, credentials, tokens, provider payloads or buyer PII.

## Message content

- **Templates.** The 20 templated types (16 order, 4 resolved) use merchant templates. Defaults are in the store's checkout language: Bangla when the active language's base code is `bn`, otherwise English. A changed template is sent as typed. Copy equal to the default is not stored.
- **Limits.** Subject 200, email body 10,000, SMS body 1,000 characters. A save rejects variables the event cannot fill.
- **Rendering.** In an email body or SMS, a line whose variables are all empty is left out. Elsewhere an empty variable is left blank and the text closes up. A subject or message that renders empty uses the event default.

| Event | Variables |
|---|---|
| Every order event | `customer_name`, `order_number`, `order_total`, `cod_amount`, `store_name` |
| `order_shipped` | + `tracking_id`, `courier_name`, `tracking_url` |
| `order_ready_for_pickup` | + `pickup_address`, `pickup_hours` |
| `order_delivered` | + `pending_downloads` |
| `refund_processing`, `refund_failed`, `order_refunded`, `order_partially_refunded` | + `refund_amount` |
| `support_request_submitted` | + `support_request` |
| `support_request_status_updated` | + `support_request`, `support_status` |
| `order_digital_delivered` | `customer_name`, `order_number`, `store_name`, `download_names`, `licence_keys`, `sms_licence_keys`, `access_link` |
| `review_request` | `customer_name`, `order_number`, `store_name`, `review_products`, `review_link` |
| `gift_card_issued` | `customer_name`, `store_name`, `gift_card_code`, `gift_card_value`, `gift_card_expires`, `gift_card_message`, `gift_card_sender`, `gift_card_link` |
| `gift_card_sent` | `customer_name`, `store_name`, `order_number`, `gift_card_value`, `gift_card_recipient` |

- **Email frame.** `renderOrderEmail()` wraps the merchant message. It shows:
  - the header logo (absolute URL) or the store name;
  - the items and totals, with each discount by promotion name and code;
  - the payment state, the delivery address and method, and the support contact;
  - one order link: `/account/orders/<id>` for account orders, `/track-order?order=<number>` for guests. Phone and email never enter URLs.

  The dashboard preview and test sends use the same renderer (`sampleOrderEmail()`).
- **Store name.** Business `companyName`, else `legalName`, else the Store URL host (`storeDisplayName`).
- **Escaping.** Every interpolated value passes `escapeHtml()`. The plain-text part is always sent.
- **WhatsApp order message.** A template message (`sendWhatsAppTemplateMessage`) with four body values: customer name, order number, event label, tracking ID or `-`. Resolved types and thread replies never use WhatsApp. A paused Meta template ends the receipt as skipped.
- **OTP copy.** `composeAuthOtpMessage()` in `store-messages.ts`. The subject starts with the code. The sender and body name the store. The language follows the checkout language.

## Staff and push

- `sendOrderNotification()` pushes to every active token in `admin_fcm_tokens`. The title is "New Order Created!" for `order_created`, else the event label. The link is `<dashboard origin>/admin/orders/<id>`. The origin is `BETTER_AUTH_URL`, the `dashboardUrl` of the `platform` settings document. Without it the link is omitted.
- With an `outboxId`, each token has its own receipt. An unregistered or invalid token ends as a skipped receipt, then `is_active` is set to false. A setup failure pauses the `push`/`fcm` provider.
- The queue handler (`apps/api/src/queue-notifications.ts`) checks the staff rule for `push`. It skips push, with a warning log, when the `apiUrl` of the `platform` settings document is empty (Settings > Store details > Web addresses).
- `sendStaffOrderEmails()` emails every `staffEmailRecipients` address for `order_created` only. Each recipient has a receipt (`staff:<email>`). The email links to the dashboard order page.
- `sendStaffAlertNotification()` sends `review_pending` and `digital_keys_exhausted` to staff with no buyer content.
- `sendConversationNotification()` sends thread notifications. Reply email carries the message text (escaped). Reply SMS carries no text and goes out at most once per thread per hour. The staff push for a buyer message names the order number and carries no message text.
- `sendAdminPushNotice()` is a best-effort push with no outbox row. `sendWebhookDisabledNotice()` uses it.
- Admin push is Firebase only. SMS has Bangladesh gateways plus app providers.

## OTP delivery

The `auth.send_otp` queue message is handled in `apps/api/src/queue-consumer.ts`, not through the outbox. Its receipts are `auth_otp_delivery_receipts`. The full flow is in the [customers README](../customers/README.md). Notification rules that apply:

- The payload holds opaque references only. The consumer reads the encrypted target from the challenge row and derives the code at send time.
- Email, SMS and WhatsApp OTP use the same pause markers. A paused provider gives a terminal skipped receipt. A setup failure writes the marker.
- WhatsApp OTP uses the `whatsapp` document's `authTemplateName` (default `auth_otp`), language `en_US`, and the code as the one body value.
- `jobs-dlq` never calls a provider. It marks the receipt `skipped` (`auth_otp_dlq_terminal`), or `accepted` when a recovery hint exists.
- If a provider accepts a code and D1 cannot record it, the consumer writes the KV hint `auth_otp:accepted:<deliveryKey>` (24 hours). It holds only the delivery key, channel and acceptance metadata. A retry repairs the receipt before any provider call.
- Logs carry delivery keys and short hash prefixes, never the code or the contact.

## Dispatch kit

Other senders reuse these exports from `index.ts`: `dispatchWithReceipt`, `recordSkippedDelivery`, `recordProviderBlockedDeliveryIfNeeded`, `buildDispatchResult`, `emailResultToDeliveryResult`, `maskEmail`. Customer marketing messages use them.

## Files

| File | Purpose |
|---|---|
| `documents.ts` | The two settings documents and channel-rule defaults |
| `channel-settings.ts` | Read and save the channel rules |
| `notification-types.ts` | Type lists, labels, channel rules per type |
| `notification-templates.ts`, `notification-templates.service.ts` | Default copy, variables, renderers; read and save templates |
| `message-copy.ts` | English and Bangla words for the email frame, requests, codes, staff mail |
| `order-email.ts`, `store-messages.ts` | Order message context; store name, logo, language, OTP message |
| `notification-outbox.ts`, `order-notification-outbox.ts` | Outbox rows, claims, flush; order helpers and dedupe keys |
| `order-notification-delivery-receipts.ts` | Receipt claims and marks |
| `notification-provider-health.ts` | Pause markers and recovery |
| `notifications.service.ts` | Order, staff and push senders; the dispatch kit |
| `resolved-notifications.ts`, `conversation-notifications.ts`, `system-notices.ts` | Resolved buyer messages and staff alerts; thread messages; webhook-disabled notice |

API side: `apps/api/src/queue-consumer.ts`, `queue-notifications.ts`, `notification-content/`, `utils/order-notification-queue.ts`, `scheduled-maintenance.ts`.
