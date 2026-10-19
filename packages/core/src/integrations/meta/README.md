# Meta (Conversions API and WhatsApp)

Server-side Meta Conversions API (CAPI) events, plus the WhatsApp Cloud API client that shares the Graph API version. Purchase events are backend-owned: they come from committed order and payment state through a durable outbox. This document is for contributors and operators. Script and Pixel checks are in the [analytics README](../../modules/analytics/README.md).

```text
Storefront browser                   API Worker                          Core (this directory)
meta-capi.ts sendServerEvent() ----> POST /api/v1/meta/events ---------> sendCapiEvent() -> Graph API
                                     (apps/api/src/routes/meta-conversions.ts)

checkout commit / payment confirmed -> meta_capi_purchase_outbox ------> purchase-outbox.ts -> sendCapiEvent()
```

## Settings

The dashboard page is Settings > Integrations (`/admin/settings/integrations`). The `meta_conversions` settings document (`metaConversionsDocument` in `packages/core/src/modules/settings/documents.ts`):

Fields: `pixelId`, `accessToken` (secret, encrypted with `CREDENTIAL_ENCRYPTION_KEY`, read strictly: unreadable ciphertext counts as no token), `testEventCode` (sent as `test_event_code`), `isEnabled` (default `false`) and `logRetentionDays` (default 30; the route accepts 1 to 365).

| Method and path | Permission |
|---|---|
| `GET /api/v1/admin/settings/meta-conversions` (masked settings, `null` before the first save, `pixelParity`, `revision`) | `analytics.view` |
| `POST /api/v1/admin/settings/meta-conversions` (saves with `expectedRevision`; 201 on the first save) | `analytics.edit` |
| `GET /api/v1/admin/settings/meta-conversions/logs` (summaries, `page` and `limit` at most 20) | `analytics.view` |
| `DELETE`, `POST /api/v1/admin/settings/meta-conversions/logs` (clear all logs; delete logs older than the retention) | `analytics.edit` |

- A save refuses placeholder values (`dummy`, `test`, `example`, `xxxx`, and similar).
- Enabling needs a pixel ID and a token. A masked or omitted token keeps the stored one. An empty token clears it. A new token needs `CREDENTIAL_ENCRYPTION_KEY` (503 without it).
- Every save clears the browser-event circuit marker (below).
- The Graph API version is `META_GRAPH_API_VERSION` in `conversions-api.ts` (`v25.0`).

## Browser events

1. The storefront layout sets `window.__META_CAPI_BROWSER_EVENTS_ENABLED__` only when the page enables analytics (the `analytics` layout prop, default on), it is not a theme preview, and Meta is enabled with a pixel ID and a token that reads strictly.
2. `sendServerEvent()` (`apps/storefront/src/lib/tracking/meta-capi.ts`) builds the payload. It adds `_fbp`, `_fbc` and the user agent, removes token, receipt and payment query parameters from `eventSourceUrl`, and merges only the `userData` the caller passes. It never reads checkout data from `sessionStorage`.
3. A Pixel event and its CAPI event share one `eventId` (`meta-event-id.ts`): `eventID` for the Pixel, `event_id` for CAPI.
4. `sendMetaCapiEvent()` (`apps/storefront/src/lib/api/tracking.ts`) makes one `POST /api/v1/meta/events` with a 2.5 s timeout and no retry. Failures stay silent in the browser.
5. The order success page tracks the Purchase Pixel only, guarded by `meta-purchase-guard.ts` against reload replay. It passes `sendCapi: false`, because the outbox owns Purchase CAPI.

Supported events: `ViewContent`, `Search`, `AddToCart`, `InitiateCheckout`, `AddPaymentInfo`, `Purchase`, `Lead`, `CompleteRegistration`.

The route runs these steps in order:

1. Validate the payload with Zod.
2. Require `eventSourceUrl` to share the origin of `STOREFRONT_URL`. A missing or different origin returns 400.
3. Read the circuit (`isMetaCapiBrowserCircuitOpen`, `apps/api/src/utils/meta-capi-circuit.ts`): a 60-second per-colo Cache API hint over the `system_kv` row `meta-capi:browser-events:circuit`. While it is open, return a success-shaped skip. No rate-limit work, Meta call or log row happens.
4. Apply the `RL_STANDARD` rate limit (`meta-events`, per client IP). Excess returns 429.
5. Add the client IP and user agent from the request headers.
6. Call `sendCapiEvent()` inside `waitUntil`. Without an execution context it awaits the call.

The route opens the circuit when `sendCapiEvent()` fails with `retryable: false` (bad credentials, disabled or unconfigured CAPI). The row lives 15 minutes (`expires_at`). Saving Meta settings deletes it (other colos follow within the hint's 60 s). Do not add hot retries, success logs, raw provider payload logs or per-event failure logs for unconfigured credentials.

## Sending (`conversions-api.ts`)

`sendCapiEvent(db, event, { encryptionKey })`:

1. Reads the settings with `getCapiSettings()`. If CAPI is disabled or lacks a pixel ID or token, it returns `{ success: false, retryable: false, skipped: true }`.
2. Hashes user data (below) and posts one event to `https://graph.facebook.com/<version>/<pixelId>/events`.
3. Logs the result with `logCapiEvent()`. A 429, a 5xx and a network error are retryable. Other HTTP errors are not.

`prepareUserData` hashes `em`, `ph`, `fn`, `ln`, `ge`, `db`, `ct`, `st`, `zp`, `country` and `external_id` (SHA-256 hex via `@scalius/shared/hash`) after Meta's normalization: trim and lowercase, digits only for `ph` and `db` (YYYYMMDD), `f` or `m` for `ge`, lowercase letters only for `ct` and `st`, lowercase letters and digits for `zp`. It drops blank `external_id` values. `client_ip_address`, `client_user_agent`, `fbc`, `fbp`, `subscription_id` and `lead_id` pass through.

## Logs (`capi-settings.ts`)

- Table `meta_conversions_logs`: unique `event_id`, `event_name`, `status` (`success`, `failed`), summaries of the request and response, a fixed-sentence `error_message`.
- A log stores summaries, not payloads. The request summary has the event count and, per event, the name, action source, source origin and path, which match-signal fields were sent, and commerce facts. It holds no user data and no `test_event_code`. The response summary has `eventsReceived`, error type and code, and the Meta trace ID.
- A repeated `event_id` updates its row. A later failure never replaces a success.
- Each log write starts a cleanup of rows older than `logRetentionDays`.

## Purchase outbox (`purchase-outbox.ts`)

- Table `meta_capi_purchase_outbox`: unique `order_id` and `event_id`, `source`, `status` (`pending`, `processing`, `sent`, `failed`, `skipped`), attempts and a claim lease. It stores no buyer data.
- The event ID is `Purchase:<orderId>`. It matches the Pixel `eventID` for deduplication.
- An order is eligible when it is not deleted and not `incomplete`, `cancelled`, `refunded` or `returned`, and it is COD, or paid, or partly paid.
- The checkout commit inserts the row in the order's commit batch (`source` `storefront-order`) when Meta is enabled with a pixel ID and a token in the checkout authority snapshot. Post-commit code then sends it (`processExistingMetaPurchaseOutboxForOrder`).
- The payment confirmation path inserts the row in the same batch as the payment change (`source` `payment-<provider>-confirmed`). The payment-event handler then starts the send in `waitUntil`.
- The `tracking_outbox_flush` job retries due rows with `flushPendingMetaPurchaseOutbox()`: 25 per run on Paid, 5 on Free. It runs every 15 minutes on Paid and every 23 minutes on Free (the cron's sweep rotation).
- Each attempt claims the row (5-minute lease) and rebuilds the event from the committed `orders` and `order_items`: source URL `<storefront origin>/order-success?orderId=<id>`, value, currency, content IDs (SKU ID, else product ID), contents, order ID and item count. Matching fields are phone, email, first and last name, city, customer ID and country `bd`.
- A disabled or unconfigured setup, a missing storefront URL, a missing or ineligible order, and a non-retryable Meta error end as `skipped`. A 429, 5xx or network failure ends as `failed` and retries with backoff `60 s x 2^(attempts-1)`, at most 1 hour.

## WhatsApp Cloud API (`../whatsapp.ts`)

- The `whatsapp` settings document: `accessToken` (secret, strict read), `phoneNumberId`, `authTemplateName` (empty means `auth_otp`). A merchant saves them with `POST /api/v1/admin/settings/auth`. The order template name and language are in the `notifications` document. Placeholder values (`dummy`, `example`, `changeme`, repeated digits) are refused on save and read as not configured.
- `sendWhatsAppTemplateMessage()` posts a template message to `https://graph.facebook.com/<version>/<phoneNumberId>/messages` with body values and an optional URL-button value. The default language is `en_US`.
- Failure handling: HTTP 408, 409, 429 and 5xx, and a 200 without a message ID, are retryable. A paused message (`message_status: paused`) is not. Provider errors are summarized with emails and phone numbers masked.
- Callers: order messages ([notifications README](../../modules/notifications/README.md)) and OTP codes (`apps/api/src/background/otp.ts`). Both use the WhatsApp pause markers. Meta has no idempotency key for these messages.
