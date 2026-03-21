# Meta Conversions API (CAPI)

Server-side event tracking via Meta's Conversions API. Sends e-commerce events (ViewContent, AddToCart, Purchase, etc.) from the storefront to Meta for ad attribution and optimization.

## Connection Status

**Fully connected end-to-end.** The storefront sends events to the API worker, which forwards them to Meta's Graph API.

```
Storefront (Browser)              API Worker (Hono)                Core Package
--------------------              ----------------                 ------------
meta-capi.ts                      meta-conversions.ts              conversions-api.ts
  sendServerEvent() --fetch-----> POST /api/v1/meta/events ------> sendCapiEvent()
                                                                     prepareUserData()
                                                                     meta.service.ts (settings/logging)
                                                                     crypto-utils.ts (hashing)
```

## End-to-End Flow

1. Storefront browser code calls `sendServerEvent()` from `apps/storefront/src/lib/tracking/meta-capi.ts`
2. This collects standard user data (fbp/fbc cookies, phone, email, name, city from sessionStorage) and merges with event-specific data
3. Dispatches `POST /api/v1/meta/events` via `sendMetaCapiEvent()` from `@/lib/api/tracking`
4. API route (`apps/api/src/routes/meta-conversions.ts`) validates the payload via Zod schema, enriches with IP/user-agent from request headers
5. Calls `sendCapiEvent()` from this package, which:
   a. Fetches CAPI settings from DB via `getCapiSettings()` (singleton row in `metaConversionsSettings`)
   b. If disabled or missing credentials, logs a diagnostic event and returns early
   c. Hashes PII fields (email, phone, name, location) via SHA-256 per Meta's requirements
   d. Sends to `https://graph.facebook.com/v19.0/{pixelId}/events`
   e. Logs success/failure to `metaConversionsLogs` table with request/response payloads
   f. Log retention configured via `logRetentionDays` from settings (default 30 days)
6. API route uses `ctx.waitUntil()` to process the event in the background (non-blocking response)

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

- `sendCapiEvent(db, event)` -- Main function. Fetches settings via `getCapiSettings()`, hashes user data, sends to Meta Graph API, logs results via `logCapiEvent()`. Response data typed as `Record<string, unknown>`. Error objects typed via `error instanceof Error` checks.
- `prepareUserData(userData)` -- Hashes PII fields per Meta's formatting rules:
  - `em` (email): lowercase, trim, SHA-256
  - `ph` (phone): digits only, SHA-256
  - `fn`/`ln` (name): lowercase, trim, SHA-256
  - `ge` (gender): lowercase, SHA-256 (only "f" or "m")
  - `db` (date of birth): digits only (YYYYMMDD), SHA-256
  - `ct`/`st` (city/state): lowercase, letters only, SHA-256
  - `zp` (zip): lowercase, alphanumeric only, SHA-256
  - `country`: lowercase, trim, SHA-256
  - Non-PII fields passed through: `client_ip_address`, `client_user_agent`, `fbc`, `fbp`, `external_id`, `subscription_id`, `lead_id`

Configuration:
- Graph API version: `v19.0`
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
- `accessToken` -- Meta access token
- `isEnabled` -- Boolean toggle
- `testEventCode` -- Optional test event code for Meta Events Manager
- `logRetentionDays` -- Configurable log retention period

Event logs are stored in `metaConversionsLogs` table:
- `eventId` (unique), `eventName`, `status` (success/failed)
- `requestPayload`, `responsePayload`, `errorMessage`
- `eventTime`, `createdAt`
- Auto-cleaned based on `logRetentionDays` setting via lazy cleanup on each log write

## Service Layer (`packages/core/src/modules/analytics/meta.service.ts`)

Standalone functions (not a class):
- `getCapiSettings(db)` -- Fetches singleton settings row
- `logCapiEvent(db, logData, retentionHours)` -- Inserts log entry and triggers lazy cleanup
- Cleanup runs based on retention hours derived from `logRetentionDays * 24`

## Storefront Client (`apps/storefront/src/lib/tracking/meta-capi.ts`)

The storefront client is a thin dispatcher that:
1. Collects `_fbp` and `_fbc` cookies (Meta click/browser IDs)
2. Reads user data from sessionStorage (`scalius_user_phone`, `scalius_user_email`, `scalius_user_name`, `scalius_user_city`)
3. Merges standard user data with event-specific user data
4. Calls `sendMetaCapiEvent()` which POSTs to `/api/v1/meta/events`

This runs in the browser. The actual CAPI call happens server-side in the API worker.

## Dependencies

- Web Crypto API (`crypto.subtle`) -- SHA-256 hashing
- `@scalius/database` -- `metaConversionsSettings`, `metaConversionsLogs` tables
- `@scalius/core/modules/analytics/meta.service` -- `getCapiSettings()` and `logCapiEvent()` functions
