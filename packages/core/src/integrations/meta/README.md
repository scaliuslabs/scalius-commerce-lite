# Meta Conversions API (CAPI)

Server-side event tracking via Meta's Conversions API. Browser storefront events cover product/search/cart/checkout behavior, while Purchase CAPI is backend-owned from committed order/payment state.

## Connection Status

**Connected end-to-end with durable Purchase delivery.** The storefront sends broad browser events to the API worker, while completed purchases are recorded in a D1 outbox and sent from backend order/payment authority points.

```
Storefront (Browser)              API Worker (Hono)                Core Package
--------------------              ----------------                 ------------
meta-capi.ts                      meta-conversions.ts              conversions-api.ts
  sendServerEvent() --fetch-----> POST /api/v1/meta/events ------> sendCapiEvent()
                                                                     prepareUserData()
                                                                     meta.service.ts (settings/logging)
                                                                     crypto-utils.ts (hashing)

order-success.astro               orders/queue/scheduled           purchase-outbox.ts
  Pixel Purchase only ----------> commit/payment confirmation ----> meta_capi_purchase_outbox
                                                                     sendCapiEvent()
```

## End-to-End Flow

1. Storefront browser code calls `sendServerEvent()` from `apps/storefront/src/lib/tracking/meta-capi.ts`
2. Pixel/CAPI paired events share the same browser-generated `eventId`; Pixel receives it as Meta's `eventID` option and CAPI receives it as `event_id`
3. The browser dispatcher collects attribution data (`_fbp`, `_fbc`, user agent), strips sensitive checkout/payment query parameters from `eventSourceUrl`, and merges only explicitly supplied event-specific `userData`
4. Purchase Pixel tracking on `/order-success` is guarded by `apps/storefront/src/lib/tracking/meta-purchase-guard.ts` so browser reloads do not replay the same order conversion; the success page passes `sendCapi: false` because backend Purchase CAPI owns delivery
5. Dispatches `POST /api/v1/meta/events` via `sendMetaCapiEvent()` from `@/lib/api/tracking`
6. API route (`apps/api/src/routes/meta-conversions.ts`) validates the payload via Zod schema, requires the event source origin to match `STOREFRONT_URL`, rate-limits the public endpoint through API KV when available, and enriches with IP/user-agent from request headers
7. Calls `sendCapiEvent()` from this package, which:
   a. Fetches CAPI settings from DB via `getCapiSettings()` (singleton row in `metaConversionsSettings`)
   b. If disabled or missing credentials, logs a diagnostic event and returns early
   c. Hashes PII fields (email, phone, name, location) via SHA-256 per Meta's requirements
   d. Sends to `https://graph.facebook.com/{META_GRAPH_API_VERSION}/{pixelId}/events`
   e. Logs success/failure to `metaConversionsLogs` with request payload user data redacted, `test_event_code` redacted, and event source URL queries removed
   f. Log retention configured via `logRetentionDays` from settings (default 30 days)
8. API route uses a guarded `ctx.waitUntil()` when present and awaits directly in local/test contexts where Hono has no Worker execution context

## Purchase CAPI Outbox

`packages/core/src/integrations/meta/purchase-outbox.ts` owns durable Purchase CAPI delivery:
- Event id is always `Purchase:{orderId}`, matching the browser Pixel `eventID` for Meta deduplication.
- COD/final-at-create storefront orders are recorded from `runStorefrontOrderPostCommitSideEffects()`.
- Stripe, SSLCommerz, and Polar online purchases are recorded only after `processPaymentConfirmed()` succeeds in the payment queue.
- The D1 table `meta_capi_purchase_outbox` stores `orderId`, `eventId`, status, attempts, leases, retry timing, and terminal send/skip timestamps. It does not store buyer PII payload snapshots.
- Each send attempt rebuilds the event from committed `orders` and `order_items`, adding purchase-only matching fields from order phone, email, name, city, country, and customer id. `sendCapiEvent()` hashes PII before Meta receives it.
- Scheduled maintenance calls `flushPendingMetaPurchaseOutbox()` with a small limit so missed/failed attempts are retried without requiring a new Cloudflare Queue binding.
- Disabled/missing CAPI setup and merchant-actionable provider credential/config HTTP failures are non-retryable skips, not hot retries. Transient 429/5xx/network failures remain retryable with D1 backoff.

## Supported Events

Validated by Zod schema in the API route:
- `ViewContent` -- Product page views
- `Search` -- Search queries
- `AddToCart` -- Cart additions
- `InitiateCheckout` -- Checkout started
- `AddPaymentInfo` -- Payment info entered
- `Purchase` -- Completed purchases
- `Lead` -- Lead generation
- `CompleteRegistration` -- Account registration

## Files

### `conversions-api.ts` -- Event Sending

- `sendCapiEvent(db, event, { encryptionKey })` -- Main function. Fetches settings via `getCapiSettings()`, strictly decrypts encrypted access tokens with the dedicated credential key, skips cheaply when credentials are unreadable or missing, hashes user data, sends to Meta Graph API, and logs redacted results via `logCapiEvent()`. Response data typed as `Record<string, unknown>`. Error objects typed via `error instanceof Error` checks.
- `redactCapiPayloadForLog(payload)` -- Removes event source query strings and replaces all `user_data` values plus `test_event_code` with redaction markers before storage or admin display.
- `prepareUserData(userData)` -- Hashes PII fields per Meta's formatting rules:
  - `em` (email): lowercase, trim, SHA-256
  - `ph` (phone): digits only, SHA-256
  - `fn`/`ln` (name): lowercase, trim, SHA-256
  - `ge` (gender): lowercase, SHA-256 (only "f" or "m")
  - `db` (date of birth): digits only (YYYYMMDD), SHA-256
  - `ct`/`st` (city/state): lowercase, letters only, SHA-256
  - `zp` (zip): lowercase, alphanumeric only, SHA-256
  - `country`: lowercase, trim, SHA-256
  - `external_id`: lowercase, trim, SHA-256; blank values are dropped
  - Non-PII fields passed through: `client_ip_address`, `client_user_agent`, `fbc`, `fbp`, `subscription_id`, `lead_id`

Configuration:
- Graph API version: `META_GRAPH_API_VERSION` from `conversions-api.ts` (currently `v25.0`; keep this aligned with Meta's supported Graph API versions)
- Default log retention: 30 days (from `DEFAULT_LOG_RETENTION_DAYS` constant, overridden by `settings.logRetentionDays`)
- Test event code support: If `testEventCode` is set in settings, it is included in the payload for Meta Events Manager testing

### `crypto-utils.ts` -- Hashing Utilities

- `sha256(input)` -- SHA-256 hash using Web Crypto API (`crypto.subtle.digest`), returns hex string
- `hashEmail(email)` -- Normalizes (lowercase, trim) then SHA-256
- `hashPhone(phone)` -- Strips non-digits then SHA-256

All hashing uses the Web Crypto API, compatible with Cloudflare Workers (no Node.js `crypto` module).

## Database

Settings are stored in the `metaConversionsSettings` table (singleton row with `id = "singleton"`):
- `pixelId` -- Meta Pixel ID
- `accessToken` -- Meta access token. New admin saves encrypt this with `CREDENTIAL_ENCRYPTION_KEY`; reads gracefully tolerate legacy plaintext so existing shops can migrate without downtime.
- `isEnabled` -- Boolean toggle
- `testEventCode` -- Optional test event code for Meta Events Manager
- `logRetentionDays` -- Configurable log retention period

Event logs are stored in `metaConversionsLogs` table:
- `eventId` (unique), `eventName`, `status` (success/failed)
- `requestPayload`, `responsePayload`, `errorMessage`; request payloads are redacted before writes and redacted again on admin reads for legacy rows
- `eventTime`, `createdAt`
- Duplicate event ids update the existing diagnostic row instead of inserting noisy duplicates; a successful event is not downgraded by a later failed duplicate
- Auto-cleaned based on `logRetentionDays` setting via lazy cleanup on each log write

## Service Layer (`packages/core/src/modules/analytics/meta.service.ts`)

Standalone functions (not a class):
- `getCapiSettings(db, encryptionKey?)` -- Fetches singleton settings row, tolerates legacy plaintext tokens, and returns no access token when an encrypted token cannot be decrypted with `CREDENTIAL_ENCRYPTION_KEY`
- `logCapiEvent(db, logData, retentionHours)` -- Inserts or updates a diagnostic log entry and triggers lazy cleanup
- Cleanup runs based on retention hours derived from `logRetentionDays * 24`

## Storefront Client (`apps/storefront/src/lib/tracking/meta-capi.ts`)

The storefront client is a thin dispatcher that:
1. Creates a Meta deduplication event id in `meta-event-id.ts`
2. Collects `_fbp` and `_fbc` cookies (Meta click/browser IDs)
3. Adds the browser user agent
4. Merges only event-specific `userData` explicitly passed by the caller
5. Calls `sendMetaCapiEvent()` which POSTs to `/api/v1/meta/events`

The browser dispatcher must not read checkout/customer PII from `sessionStorage` or auto-enrich broad browsing events. Checkout PII should remain scoped to checkout/order APIs; any CAPI PII must be intentionally supplied for a narrow conversion event and is hashed server-side before Meta receives it.

This runs in the browser. The actual CAPI call happens server-side in the API worker. Storefront product and purchase tracking must not be gated on `window.fbq`; CAPI should still dispatch when Pixel is blocked.

## Dependencies

- Web Crypto API (`crypto.subtle`) -- SHA-256 hashing
- `@scalius/database` -- `metaConversionsSettings`, `metaConversionsLogs`, `metaCapiPurchaseOutbox`, `orders`, and `orderItems` tables
- `@scalius/core/modules/analytics/meta.service` -- `getCapiSettings()` and `logCapiEvent()` functions
