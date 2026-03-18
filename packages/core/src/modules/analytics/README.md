# Analytics

Third-party analytics script management, Meta Conversions API integration, and admin dashboard statistics.

## Files

- `index.ts` -- barrel exports (exports dashboard.service, analytics.schema, analytics.service; does NOT export meta.service)
- `analytics.service.ts` -- `AnalyticsService` class (static methods for CRUD on analytics scripts)
- `analytics.schema.ts` -- Zod validation schemas for create/update/toggle
- `dashboard.service.ts` -- `getDashboardStats()`, `getRecentOrders()`, `getDailyActivityData()`
- `meta.service.ts` -- `MetaService` class for Meta Conversions API settings and log management

## Analytics Scripts

### `AnalyticsService` (static class)

| Method | Description |
|--------|-------------|
| `listScripts(db)` | Returns all analytics rows with formatted ISO timestamps |
| `getScript(db, id)` | Get single script by ID |
| `createScript(db, data)` | Insert new script. ID format: `analytics_{nanoid}`. Timestamps via `unixepoch()` |
| `updateScript(db, id, data)` | Full update of all fields. Returns null if not found |
| `toggleScript(db, id, isActive)` | Toggle active status only |
| `deleteScript(db, id)` | Hard-delete. Returns the deleted script for confirmation |

### Zod Schemas (`analytics.schema.ts`)

- `createAnalyticsSchema` -- name (3-100 chars), type (google_analytics | facebook_pixel | custom), isActive (default true), usePartytown (default true), config (non-empty string), location (head | body_start | body_end)
- `updateAnalyticsSchema` -- same fields plus `id` (required)
- `toggleAnalyticsSchema` -- `{ isActive: boolean }`

## Dashboard Statistics

### `getDashboardStats(db)`
Returns aggregated metrics in a single Promise.all (5 parallel queries):
- `totalProducts` -- active, non-deleted products count
- `totalCustomers` -- non-deleted customers count
- `totalRevenue` -- lifetime revenue (excludes cancelled/returned)
- `currentMonth` -- orders, revenue, orderGrowth (% vs last month), revenueGrowth, orderStatus breakdown (delivered, processing, shipping, cancelled)
- `lastMonth` -- orders, revenue

### `getRecentOrders(db, limit=5)`
Returns N most recent orders with customerName, totalAmount, status, createdAt (converted from unix to Date).

### `getDailyActivityData(db, days)`
Returns per-day arrays for the last N days with zero-filling for days with no data:
- `date` (YYYY-MM-DD), `orders`, `revenue`, `newCustomers`

## Meta Conversions API

### `MetaService` (static class)

| Method | Description |
|--------|-------------|
| `getCapiSettings(db)` | Fetch singleton Meta CAPI settings from `metaConversionsSettings` (id = "singleton") |
| `logCapiEvent(db, logData, retentionHours=12)` | Insert event log + trigger lazy cleanup |
| `performLogCleanup(db, retentionHours)` | Delete logs older than retention period |
| `manualLogCleanup(db, retentionHours)` | Admin-triggered cleanup, returns success/failure message |

## API Endpoints

### Admin Analytics (`/api/v1/admin/analytics`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List all analytics scripts |
| POST | `/` | Create script (201) |
| GET | `/{id}` | Get script by ID |
| PUT | `/{id}` | Update script. Validates ID match |
| DELETE | `/{id}` | Hard-delete script |
| POST | `/{id}/toggle` | Toggle isActive status |

### Admin Dashboard (`/api/v1/admin/dashboard`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Returns `{ stats, recentOrders, dailyActivityData }`. Fetches 11 recent orders and 90 days of daily activity |

### Admin Meta Conversions (`/api/v1/admin/settings/meta-conversions`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Get Meta CAPI settings (masks accessToken) |
| POST | `/` | Save settings. Preserves existing token if masked value submitted. Upserts singleton row |
| GET | `/logs` | Get paginated logs with retention info. Query params: page, limit |
| DELETE | `/logs` | Clear ALL logs (hard-delete entire table) |
| POST | `/logs` | Trigger manual log cleanup based on retention hours |

### Public Analytics (`/api/v1/analytics`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/configurations` | Get active analytics scripts with Partytown processing applied. Cache middleware (TTL=0) |

### Public Meta Conversions (`/api/v1/meta`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/events` | Send a CAPI event. Uses `waitUntil()` for async processing. Validates event payload with Zod (ViewContent, Search, AddToCart, InitiateCheckout, AddPaymentInfo, Purchase, Lead, CompleteRegistration) |

## Admin UI Components

- `AnalyticsForm.tsx` -- React Hook Form + Zod. Create/edit analytics scripts. Type-aware config examples (GA, FB Pixel, custom). Partytown toggle. Navigates to `/admin/analytics` on success
- `AnalyticsList.tsx` -- Table with client-side pagination (AdminListPagination). Toggle active, edit (navigates to edit page), delete (with confirmation dialog)
- `DashboardStats.tsx` -- 4 stat cards (Monthly Orders, Monthly Revenue, Total Customers, Active Products) with trend badges. Lazy-loads DashboardChart. Uses framer-motion stagger animation. Uses `useCurrency()` hook for symbol
- `DashboardChart.tsx` -- Recharts AreaChart with dual Y-axes (revenue left, orders right). Time range selector (7d/30d/90d). Custom tooltip with currency formatting. Three data series: revenue, orders, newCustomers

## Loaders

- `apps/admin/src/loaders/admin/analytics.ts` -- `getAnalyticsListData()`, `getAnalyticsEditData(id)` via `apiGet`
- `apps/admin/src/loaders/admin/dashboard.ts` -- `getDashboardData()` via `apiGet("/dashboard")`

## Storefront Consumers

- `apps/storefront/src/lib/api/settings.ts` -- `getAnalyticsConfigurations()` fetches `/analytics/configurations`, edge-cached with CACHE_TTL.LONG
- `apps/storefront/src/lib/api/storefront.ts` -- `getLayoutData()` fetches `/storefront/layout` which includes analytics in the layout bundle

## Dependencies

- `@scalius/database` -- `analytics`, `products`, `customers`, `orders`, `metaConversionsSettings`, `metaConversionsLogs`
- `@paralleldrive/cuid2` -- ID generation for Meta CAPI logs
- `nanoid` -- ID generation for analytics scripts
- `@scalius/core/integrations/analytics` -- Partytown script processing
- `@scalius/core/integrations/meta/conversions-api` -- `sendCapiEvent()`, retention config

## Known Gaps

- Meta CAPI admin route (`meta-conversions-admin.ts`) imports `db` directly from `@scalius/database/client` instead of using `c.get("db")`.
- `MetaService` is not exported from the barrel `index.ts` -- must be imported directly from `meta.service.ts`.
- Analytics scripts are hard-deleted (no soft-delete/trash).
- Dashboard daily activity uses `gte(orders.createdAt, startDate)` which passes a JS Date object directly -- works because Drizzle coerces it, but inconsistent with other unix-timestamp queries.
