# Notifications

The notifications domain sends buyer and staff messages over email, SMS, WhatsApp and admin push. It owns the outbox, the delivery receipts, the channel rules, the message templates and the provider pause markers. This document is for contributors and operators.

## Where it fits

- Layer L6. Imports from other domains: `order-kernel`, `platform`, `settings` (`scripts/core-domain-graph.allow.json`).
- `index.ts` is the server API. `browser.ts` is the closed browser entry: `notification-types.ts`, `message-copy.ts` and `notification-templates.ts` (pure, no database).
- Provider clients live in `packages/core/src/integrations/` (`email`, `sms`, `whatsapp.ts`, `firebase`, `provider-port.ts`).
- The API resolves message content from the digital, gift-cards and reviews domains at send time (`apps/api/src/notification-content/*`).
- OTP codes and challenges belong to the customers domain ([README](../customers/README.md)). This domain supplies only the message copy and the provider pause markers.

## Channels and providers

| Channel | Audience | Provider | Credentials (settings document) | Readiness check |
|---|---|---|---|---|
| Email | buyer, staff | Cloudflare Email Service (default, `EMAIL` binding), Resend, or an app provider | `email` | `getEmailProviderReadiness` |
| SMS | buyer | an app provider (the Bangladesh gateways are the Bangladesh pack's) | `sms` | `getSmsProviderReadiness` |
| WhatsApp | buyer | Meta Cloud API template message | `whatsapp` | `isWhatsAppCloudApiConfigured` |
| Push | staff | Firebase Cloud Messaging | `firebase` | `getFirebaseServiceAccountReadiness` |

- Email and SMS are provider ports. A saved choice `<plugin id>:<provider id>` names an app provider. Core asks the API's `AppProviders` lookup only for that case (`provider-port.ts`, [Plugins](../plugins/README.md)). Without a lookup, an app choice is not ready and nothing is sent. WhatsApp and push are not ports.
- An app answer `retryable: false` ends the receipt as skipped. An uncertain retryable failure is retried only when the message has an idempotency key (`apps/api/src/plugins/providers/messaging.ts`).
- Credentials use strict reads with `CREDENTIAL_ENCRYPTION_KEY`. Never fall back to a JWT secret. Unreadable ciphertext counts as not configured. SMS and WhatsApp also treat placeholder values (`dummy`, `example`, `changeme`, `your-token-here`, repeated digits) as not configured.
- Setup docs: [email](../../integrations/email/README.md), [Firebase](../../integrations/firebase/README.md), [WhatsApp and Meta](../../integrations/meta/README.md).

## Notification types

`notification-types.ts` is the source of truth for the lists, labels and channel rules.

| Group | Types | Buyer channels | Staff channels |
|---|---|---|---|
| Order (`ORDER_NOTIFICATION_TYPES`, 16) | `order_created` through `order_partially_refunded`, `payment_balance_paid`, `support_request_submitted`, `support_request_status_updated` | email, sms, whatsapp | push |
| Conversation | `conversation_reply` (to the buyer), `conversation_message` (to staff) | reply: email, sms | message: push, email |
| Resolved (4) | `order_digital_delivered`, `gift_card_issued`, `gift_card_sent`, `review_request` | email, sms | none |
| Staff alert | `review_pending`, `digital_keys_exhausted` | none | push, email |

- `marketing_opt_in` (double opt-in email) is a buyer flow, not a merchant choice.
- Defaults (`DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS`, `DEFAULT_ADMIN_NOTIFICATION_CHANNELS` in `documents.ts`): buyers get email for every buyer type, plus SMS for `order_ready_for_pickup`, `order_digital_delivered` and `gift_card_issued`, and never WhatsApp. Staff get push for `order_created`, `order_cancelled`, `support_request_submitted`, `conversation_message` and `review_pending`, and push plus email for `digital_keys_exhausted`.
- Support notification payloads carry only the order id, request id, request type and status. Free-form customer text stays out of provider payloads.
- Status changes send a notification only for shipped, delivered, cancelled, returned and refunded orders (`getOrderNotificationTypeForStatus` in `apps/api/src/utils/order-notifications.ts`). Other flows (checkout, refunds, pickup, support, fulfilment, reviews) write their own rows.

## Settings

| Document | Contents |
|---|---|
| `notifications` | `orderChannels`, `adminChannels` (event -> channels), `staffEmailRecipients` (at most 10), `whatsappOrderTemplateName` (default `order_status_update`), `whatsappOrderTemplateLanguage` (default `en_US`) |
| `notification_templates` | Only the email subject/body and SMS body the merchant changed |

- Both are declared in `documents.ts` with `defineSettingsDocument()`. A save sends `expectedRevision`. A stale revision returns 409.
- `channel-settings.ts` saves the rules. A channel can be newly enabled only while its provider is ready and not paused. The dashboard disables the checkbox of an unready channel (a rule that is already on can still be switched off). The backend refuses a stale client that enables it.
- Provider pause markers are `settings` rows with category `notification_provider_health` and key `<channel>:<provider>`, not documents.

## Admin routes

All paths start with `/api/v1/admin`.

| Method and path | Permission |
|---|---|
| `GET /settings/notification-channels`, `GET /settings/notification-channels/templates` | `settings.general.view` |
| `PUT /settings/notification-channels` (buyer rules, order template) | `settings.notifications.edit` |
| `PUT /settings/notification-channels/admin-channels` (staff rules, recipients) | `settings.notifications.edit` |
| `PUT /settings/notification-channels/templates` (one event's templates) | `settings.notifications.edit` |
| `POST /settings/notification-channels/templates/test` | `settings.notifications.edit` (rate limit `RL_STRICT`) |
| `GET`, `POST /settings/sms` | `settings.general.view`, `settings.notifications.edit` |
| `POST /settings/auth` (sign-in policy, WhatsApp credentials) | `settings.general.edit` |
| `GET /orders/{id}/notifications` (newest 20 outbox rows with receipts) | `orders.view` |
| `POST /orders/{id}/notifications/{outboxId}/retry` | `orders.edit` |
| `POST /orders/{id}/notifications/{outboxId}/resend` | `orders.edit` |

- Retry works on a `pending`, `failed` or `dead_lettered` row. It resets the pending and failed receipts and sends the same row. Accepted and skipped receipts stay terminal, so nothing is sent twice.
- Resend works on a `sent` row and creates a new row. It needs a request id (the `Idempotency-Key` header or `resendRequestId`). Its dedupe key is `manual_resend:<outboxId>:<resendRequestId>`.
- Email, Firebase and push-token routes are in the integration READMEs.

## Delivery pipeline

```text
fact commits
  -> notification_outbox row (pending), same batch as the fact or right after
  -> after the response: the sender claims the row by id, reads recipient and text now
     (the cron's notification_drain sends every due row each minute)
  -> one notification_delivery_receipts row per channel and recipient
  -> provider call -> receipt accepted | skipped | failed
  -> outbox row sent | failed (backoff) | dead_lettered
```

- Table `notification_outbox`. Subjects: `order`, `conversation`, `gift_card`, `digital`, `customer`. The sender dispatches `order`, `gift_card`, `customer` (`marketing_opt_in` only) and `conversation`. It dead-letters any other subject as unsupported.
- The row and the sender's argument carry ids only. `sanitizeNotificationData` keeps at most 12 short primitive facts and drops keys that look like a contact, text, code or token. Nothing resolved at send time is persisted.
- `dedupe_key` is unique.
- Row states: `pending`, `processing`, `sent`, `failed`, `dead_lettered`. The processing lease is 15 minutes. Each claim adds one attempt. At 8 attempts the row becomes `dead_lettered`.
- Backoff is `60 s x 2^(attempts-1)`, at most 1 hour. A failed delivery marks the row `failed`. The drain is the retry authority.
- `notification_drain` runs on every cron tick (every minute) on both plans. It sends due rows and rows with an expired lease, at most `planLimits().background.notificationsPerDrain` per tick (1 on Free, 20 on Paid). The sender after a write sends at most the same number; the drain sends the rest.
- `NotificationInput.notBefore` schedules a row. It becomes `next_attempt_at`.

## Delivery receipts

- Table `notification_delivery_receipts`. `receipt_key` is `<outboxId>:<channel>:<sha256 of the lowercase recipient>`. The table stores only the hash and a masked recipient.
- States: `pending`, `processing` (15-minute lease), `accepted`, `delivered`, `skipped`, `failed`. `accepted`, `delivered` and `skipped` are terminal.
- A retryable failure waits with the same backoff. At 8 attempts (`MAX_ORDER_NOTIFICATION_DELIVERY_ATTEMPTS`) the receipt becomes `skipped` with `delivery_attempt_limit_reached`.
- Provider idempotency: Resend gets the receipt key as `Idempotency-Key`. Cloudflare Email returns a `messageId`. An SMS app gets the receipt key as `idempotencyKey` (the Bangladesh pack sends it to GenNet as a 20-character `csms_id`). Meta WhatsApp has no idempotency key, so a Worker crash after Meta accepts and before the receipt write can send twice.
- Code-bearing types (`order_digital_delivered`, `gift_card_issued`) store no `raw_response`. The dispatcher removes the resolved values from every status and error it records.

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
- **Limits.** Subject 200, email body 10,000, SMS body 1,000 characters. A save rejects variables the event cannot fill (`variablesForEvent()` in `notification-templates.ts` lists them per event).
- **Rendering.** In an email body or SMS, a line whose variables are all empty is left out. Elsewhere an empty variable is left blank and the text closes up. A subject or message that renders empty uses the event default.
- **Email frame.** `renderOrderEmail()` wraps the merchant message: the header logo (absolute URL) or the store name, the items and totals (each discount by promotion name and code), the payment state, the delivery address and method, the support contact and one order link. The link is `/account/orders/<id>` for account orders and `/track-order?order=<number>` for guests. Phone and email never enter URLs.
- **Store name.** Business `companyName`, else `legalName`, else the Store URL host (`storeDisplayName`).
- **Escaping.** Every interpolated value passes `escapeHtml()`. The plain-text part is always sent.
- **WhatsApp order message.** A template message (`sendWhatsAppTemplateMessage`) with four body values: customer name, order number, event label, tracking ID or `-`. Resolved types and thread replies never use WhatsApp. A paused Meta template ends the receipt as skipped.
- **OTP copy.** `composeAuthOtpMessage()` in `store-messages.ts`. The language follows the checkout language.

## Staff and push

- `sendOrderNotification()` pushes to every active token in `admin_fcm_tokens`. The link is `<dashboard origin>/admin/orders/<id>`, from the `dashboardUrl` of the `platform` settings document (`BETTER_AUTH_URL`). Without it the link is omitted.
- With an `outboxId`, each token has its own receipt. An unregistered or invalid token ends as a skipped receipt, then `is_active` becomes false. A setup failure pauses the `push`/`fcm` provider.
- The sender (`apps/api/src/background/notifications.ts`) checks the staff rule for `push`. It skips push, with a warning log, when the `apiUrl` of the `platform` settings document is empty (Settings > Store details > Web addresses).
- `sendStaffOrderEmails()` emails every `staffEmailRecipients` address for `order_created` only. Each recipient has a receipt (`staff:<email>`).
- `sendStaffAlertNotification()` sends `review_pending` and `digital_keys_exhausted` to staff with no buyer content.
- `sendConversationNotification()` sends thread notifications. Reply email carries the escaped message text. Reply SMS carries no text and goes out at most once per thread per hour. The staff push for a buyer message names the order number and carries no message text.
- `sendAdminPushNotice()` is a best-effort push with no outbox row (`sendWebhookDisabledNotice()` uses it).
- Staff Web Push and FCM recheck current bans, grants, denials and permission prerequisites through `staff-push-policy.ts`; a saved device is not an access grant. Unknown notice types fail closed.
- Web Push removes subscriptions only on HTTP 404/410 or typed invalid subscriber keys. Other delivery/encryption failures retain subscriptions. Provider acceptance and a service-worker receipt do not prove native display or sound; the account test asks separately about an audible banner, a silent banner, or no banner. Browser/OS audio cannot be guaranteed by `renotify`.

## OTP delivery

Sign-in codes are sent by `apps/api/src/background/otp.ts` right after the response, not through the outbox. Its receipts are `auth_otp_delivery_receipts`. The [customers README](../customers/README.md) owns the flow (opaque payload, send-time code, receipts). Notification rules that apply:

- Email, SMS and WhatsApp OTP use the same pause markers. A paused provider gives a terminal skipped receipt.
- WhatsApp OTP uses the `whatsapp` document's `authTemplateName` (default `auth_otp`), language `en_US`, and the code as the one body value.
- If a provider accepts a code and D1 cannot record it after brief retries, the receipt keeps its lease and no later attempt sends again; the buyer may ask for a new code. The receipt is the only authority; there is no KV hint.

## Dispatch kit

Other senders (customer marketing messages) reuse these exports from `index.ts`: `dispatchWithReceipt`, `recordSkippedDelivery`, `recordProviderBlockedDeliveryIfNeeded`, `buildDispatchResult`, `emailResultToDeliveryResult`, `maskEmail`.
