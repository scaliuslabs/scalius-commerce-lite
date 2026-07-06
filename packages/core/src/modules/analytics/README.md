# Analytics

Third-party analytics script management, Meta Conversions API integration, and admin dashboard statistics.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports dashboard.service, analytics.validation, analytics.service, meta.service, meta-pixel-parity) |
| `analytics.service.ts` | Standalone functions for CRUD on analytics scripts |
| `analytics.validation.ts` | Zod validation schemas for create/update/toggle |
| `dashboard.service.ts` | `getDashboardSummaryStats()`, `getDashboardStats()`, `getRecentOrders()`, `getDailyActivityData()` |
| `meta.service.ts` | Standalone functions for Meta Conversions API settings and log management |
| `meta-pixel-parity.ts` | Pure parser/diagnostic helpers for comparing CAPI Pixel ID with active browser Pixel snippets |

## Analytics Scripts

### Exported Functions (`analytics.service.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `listAnalyticsScripts` | `(db: Database)` | Returns all analytics rows with formatted ISO timestamps |
| `getAnalyticsScript` | `(db: Database, id: string)` | Get single script by ID |
| `createAnalyticsScript` | `(db: Database, data: CreateAnalyticsInput)` | Insert new script. ID format: `analytics_{nanoid}`. Timestamps via `unixepoch()`. Returns `{ id, script }` |
| `updateAnalyticsScript` | `(db: Database, id: string, data: UpdateAnalyticsInput)` | Full update of all fields. Returns null if not found |
| `toggleAnalyticsScript` | `(db: Database, id: string, isActive: boolean)` | Toggle active status only |
| `deleteAnalyticsScript` | `(db: Database, id: string)` | Hard-delete. Returns the deleted script for confirmation, null if not found |

### Zod Schemas (`analytics.validation.ts`)

- `createAnalyticsSchema` -- name (3-100 chars), type (`google_analytics` | `google_tag_manager` | `facebook_pixel` | `tiktok_pixel` | `cloudflare_web_analytics` | `custom`), isActive (default true), usePartytown (default true), config (non-empty string), location (`head` | `body_start` | `body_end`)
- `updateAnalyticsSchema` -- same fields plus `id` (required)
- `toggleAnalyticsSchema` -- `{ isActive: boolean }`

Google Analytics and Google Tag Manager are separate first-class browser
provider types. Use `google_analytics` for GA4 `gtag.js` snippets with `G-`
measurement IDs. Use `google_tag_manager` for GTM web container snippets with
`GTM-` container IDs; if a merchant wants the optional GTM noscript iframe, add
it as a separate `body_start` custom snippet.

TikTok Pixel is a first-class browser provider type. Use `tiktok_pixel` for the
TikTok base code that loads `https://analytics.tiktok.com/i18n/pixel/events.js`,
calls `ttq.load('PIXEL_ID')`, and calls `ttq.page()`. It remains Partytown-capable
by default like Facebook Pixel, GA4, and GTM snippets.
Partytown analytics proxy targets must use HTTPS; HTTP, FTP, and other protocols are rejected before fetch.

Cloudflare Web Analytics is first-class because it is the default Cloudflare-native
alternative to GA/Facebook page analytics. Admins may paste either the Cloudflare
site token or the official beacon snippet. Valid token-only saves and pasted
beacon snippets are canonicalized to the platform-generated
`https://static.cloudflareinsights.com/beacon.min.js` snippet, placeholder
tokens are blocked before activation and legacy toggles, `usePartytown` is forced
off, and the admin UI defaults it to `body_end` so the beacon can read browser
performance timing directly.

## Dashboard Statistics

### `getDashboardSummaryStats(db: Database)`
Returns lightweight admin-home metrics without the lifetime revenue scan:
- `totalProducts` -- active, non-deleted products count
- `totalCustomers` -- non-deleted customers count
- `currentMonth` -- orders, revenue, orderGrowth (% vs last month), revenueGrowth, orderStatus breakdown (delivered, processing, shipping, cancelled)
- `lastMonth` -- orders, revenue

### `getDashboardStats(db: Database)`
Returns the full dashboard metrics contract for legacy/full-summary callers:
- all fields from `getDashboardSummaryStats()`
- `totalRevenue` -- lifetime revenue (excludes cancelled/returned)

### `getRecentOrders(db: Database, limit = 5)`
Returns N most recent non-deleted orders with customerName, totalAmount, status, createdAt (converted from unix to Date).

### `getDailyActivityData(db: Database, days: number)`
Returns per-day arrays for the last N days with zero-filling for days with no data:
- `date` (YYYY-MM-DD), `orders`, `revenue`, `newCustomers`

Dashboard reads emit generic Worker log events under `[dashboard-query]` with
`dashboard_query_completed`, `dashboard_query_retry`, or `dashboard_query_failed`.
Labels are `summary_stats`, `full_stats`, `recent_orders`, and
`daily_activity_{days}d`; payloads include duration and attempt counts only, not
order/customer values.

Dashboard SQL/index changes should be evidence-driven. On the current production
D1 shape, `recent_orders` with `deleted_at IS NULL` uses `orders_dashboard_agg_idx`,
`daily_activity_90d` uses `orders_dashboard_agg_idx` for orders and
`customers_dashboard_activity_idx` for customers, and remote query plans were
sub-millisecond on 2026-06-29. Avoid adding dashboard-specific write-path indexes
unless `[dashboard-query]` logs or remote `EXPLAIN QUERY PLAN` output show a real
slow/retry hotspot.

## Meta Conversions API

### Exported Functions (`meta.service.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `getCapiSettings` | `(db: Database, encryptionKey?: string)` | Fetch singleton Meta CAPI settings from `metaConversionsSettings` (id = `"singleton"`). Strictly decrypts encrypted access tokens with the dedicated credential key, returns no access token for unreadable ciphertext, and tolerates legacy plaintext. Returns `MetaConversionsSettings | null`. Typed catch blocks (`error: unknown`). |
| `logCapiEvent` | `(db: Database, logData, retentionHours = 12)` | Insert event log + trigger lazy cleanup via fire-and-forget `void performLogCleanup()`. Callers must pass redacted request payloads; the Meta CAPI route also redacts legacy stored payloads on admin reads. Uses `@paralleldrive/cuid2` for log IDs. |
| `performLogCleanup` | `(db: Database, retentionHours: number)` | Delete logs older than retention period. |
| `manualLogCleanup` | `(db: Database, retentionHours: number)` | Admin-triggered cleanup, returns `{ success: boolean; message: string }`. Uses `error instanceof Error` check in catch. |

### Browser Pixel Parity (`meta-pixel-parity.ts`)

`GET /api/v1/admin/settings/meta-conversions` includes a non-persisted
`pixelParity` diagnostic. It compares the saved Meta CAPI Pixel ID with active
analytics snippets that clearly initialize a browser Pixel through
`fbq('init', 'numeric_pixel_id')`. The check is warning-only and must never block
settings saves: if the analytics read fails, the API returns `status:
"unavailable"` with the masked settings row.

The parser intentionally does not trust `window.fbq`; storefront layout creates
analytics queues before merchant snippets run, so a runtime `fbq` function is not
proof that a browser Pixel is configured. It also ignores placeholder IDs,
non-numeric IDs, `fbq('track', ...)`, and noscript-only image URLs. Typed
`facebook_pixel` rows with no readable init become `unreadable_browser_pixel`;
custom snippets count only when they contain a readable `fbq('init', ...)`.

## Dependencies

- `@scalius/database` -- `analytics`, `products`, `customers`, `orders`, `metaConversionsSettings`, `metaConversionsLogs`
- `@paralleldrive/cuid2` -- ID generation for Meta CAPI logs
- `nanoid` -- ID generation for analytics scripts
