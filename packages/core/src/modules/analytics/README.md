# Analytics

Third-party analytics script management, Meta Conversions API integration, and admin dashboard statistics.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports dashboard.service, analytics.validation, analytics.service, meta.service) |
| `analytics.service.ts` | Standalone functions for CRUD on analytics scripts |
| `analytics.validation.ts` | Zod validation schemas for create/update/toggle |
| `dashboard.service.ts` | `getDashboardSummaryStats()`, `getDashboardStats()`, `getRecentOrders()`, `getDailyActivityData()` |
| `meta.service.ts` | Standalone functions for Meta Conversions API settings and log management |

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

- `createAnalyticsSchema` -- name (3-100 chars), type (`google_analytics` | `facebook_pixel` | `cloudflare_web_analytics` | `custom`), isActive (default true), usePartytown (default true), config (non-empty string), location (`head` | `body_start` | `body_end`)
- `updateAnalyticsSchema` -- same fields plus `id` (required)
- `toggleAnalyticsSchema` -- `{ isActive: boolean }`

Cloudflare Web Analytics is first-class because it is the default Cloudflare-native
alternative to GA/Facebook page analytics. Admins may paste either the Cloudflare
site token or the official beacon snippet. Token-only saves are normalized to the
`https://static.cloudflareinsights.com/beacon.min.js` snippet, `usePartytown` is
forced off, and the admin UI defaults it to `body_end` so the beacon can read
browser performance timing directly.

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
Returns N most recent orders with customerName, totalAmount, status, createdAt (converted from unix to Date).

### `getDailyActivityData(db: Database, days: number)`
Returns per-day arrays for the last N days with zero-filling for days with no data:
- `date` (YYYY-MM-DD), `orders`, `revenue`, `newCustomers`

## Meta Conversions API

### Exported Functions (`meta.service.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `getCapiSettings` | `(db: Database, encryptionKey?: string)` | Fetch singleton Meta CAPI settings from `metaConversionsSettings` (id = `"singleton"`). Gracefully decrypts encrypted access tokens when a key is supplied and tolerates legacy plaintext. Returns `MetaConversionsSettings | null`. Typed catch blocks (`error: unknown`). |
| `logCapiEvent` | `(db: Database, logData, retentionHours = 12)` | Insert event log + trigger lazy cleanup via fire-and-forget `void performLogCleanup()`. Callers must pass redacted request payloads; the Meta CAPI route also redacts legacy stored payloads on admin reads. Uses `@paralleldrive/cuid2` for log IDs. |
| `performLogCleanup` | `(db: Database, retentionHours: number)` | Delete logs older than retention period. |
| `manualLogCleanup` | `(db: Database, retentionHours: number)` | Admin-triggered cleanup, returns `{ success: boolean; message: string }`. Uses `error instanceof Error` check in catch. |

## Dependencies

- `@scalius/database` -- `analytics`, `products`, `customers`, `orders`, `metaConversionsSettings`, `metaConversionsLogs`
- `@paralleldrive/cuid2` -- ID generation for Meta CAPI logs
- `nanoid` -- ID generation for analytics scripts
