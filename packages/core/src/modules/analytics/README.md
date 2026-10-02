# Analytics

Third-party analytics script management, Meta Conversions API integration, admin dashboard statistics, and the Analytics overview and reports (see "Analytics and reports").

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports dashboard.service, analytics.validation, analytics.service, meta.service, meta-pixel-parity, provider-health, reports) |
| `reports/` | The Analytics overview and reports (see "Analytics and reports") |
| `analytics.service.ts` | Standalone functions for CRUD on analytics scripts |
| `analytics.validation.ts` | Zod validation schemas for create/update/toggle |
| `dashboard.service.ts` | `getDashboardHomeSummary()`, `getDailyActivityData()` |
| `meta.service.ts` | Standalone functions for Meta Conversions API settings and log management |
| `meta-pixel-parity.ts` | Pure parser/diagnostic helpers for comparing CAPI Pixel ID with active browser Pixel snippets |
| `provider-health.ts` | Read-only provider readiness summary for admin UI/API without provider calls or secret/script echo |

## Analytics Scripts

### Exported Functions (`analytics.service.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `listAnalyticsScripts` | `(db, options)` | Server-paginated/searchable safe summaries; never returns executable config |
| `getAnalyticsScript` | `(db: Database, id: string)` | Get single script by ID |
| `createAnalyticsScript` | `(db, data, authority?)` | Defaults inactive; active create requires verified `analytics.toggle` authority. |
| `updateAnalyticsScript` | `(db, id, data, authority?)` | Revision-guarded edit; changing status requires verified `analytics.toggle` authority. |
| `toggleAnalyticsScript` | `(db, id, { isActive, expectedRevision, allowDuplicateProvider? })` | Revision-guarded lifecycle command with duplicate-provider acknowledgement |
| `deleteAnalyticsScript` | `(db, id, expectedRevision)` | Deactivates and moves the current row to recoverable trash |
| `restoreAnalyticsScript` | `(db, id, expectedRevision)` | Restores the current trash row as inactive |
| `permanentlyDeleteAnalyticsScript` | `(db, id, expectedRevision)` | Permanently removes only the current trash row |

### Zod Schemas (`analytics.validation.ts`)

- `createAnalyticsSchema` -- name (3-100 chars), type (`google_analytics` | `google_tag_manager` | `facebook_pixel` | `tiktok_pixel` | `cloudflare_web_analytics` | `custom`), isActive (default false), usePartytown (default true), config (non-empty string), location (`head` | `body_start` | `body_end`)
- `updateAnalyticsSchema` -- same fields plus `id` (required)
- `toggleAnalyticsSchema` -- `{ isActive: boolean }`

Google Analytics and Google Tag Manager are separate first-class browser
provider types. Use `google_analytics` for GA4 `gtag.js` snippets with `G-`
measurement IDs. Use `google_tag_manager` for GTM web container snippets with
`GTM-` container IDs; if a merchant wants the optional GTM noscript iframe, add
it as a separate `body_start` custom snippet.

Active first-class analytics snippets are shape-checked before create/update,
legacy toggle activation, and public injection. GA4 must look like `gtag.js`
with a `G-` measurement ID, GTM must include a `GTM-` container ID, Facebook
Pixel must include a readable numeric `fbq('init', ...)`, and TikTok Pixel must
include the official load signal. Keep inactive drafts permissive so merchants
can paste and repair snippets without publishing broken tracking.

TikTok Pixel is a first-class browser provider type. Use `tiktok_pixel` for the
TikTok base code that loads `https://analytics.tiktok.com/i18n/pixel/events.js`,
calls `ttq.load('PIXEL_ID')`, and calls `ttq.page()`. TikTok, Facebook Pixel,
GA4, and GTM are always worker-isolated through Partytown, including legacy rows
whose stored flag was false. Cloudflare Web Analytics remains on the main thread
for browser performance timing, and trusted custom code alone may opt in or out.
Partytown analytics proxy targets must use HTTPS; HTTP, FTP, and other protocols are rejected before fetch.

Cloudflare Web Analytics is first-class because it is the default Cloudflare-native
alternative to GA/Facebook page analytics. Admins may paste either the Cloudflare
site token or the official beacon snippet. Valid token-only saves and pasted
beacon snippets are canonicalized to the platform-generated
`https://static.cloudflareinsights.com/beacon.min.js` snippet, placeholder
tokens are blocked before activation and legacy toggles, `usePartytown` is forced
off, and the admin UI defaults it to `body_end` so the beacon can read browser
performance timing directly.

## Provider Health

`getAnalyticsProviderHealth()` powers the admin Provider Readiness card and
`GET /api/v1/admin/analytics/health`. It is intentionally read-only and cheap:
the helper reads analytics rows plus the singleton Meta CAPI settings row,
strict-reads the encrypted Meta access token with `CREDENTIAL_ENCRYPTION_KEY`,
and returns provider-level status messages/counts. It must not call GA, GTM,
Meta, TikTok, Cloudflare, or custom snippet URLs, must not send test events, and
must not return script config, access tokens, or provider payloads.

## Dashboard Statistics

Home's sales numbers (total sales, orders, AOV, RTS rate and the trend) come
from the Analytics overview for staff with `dashboard.analytics`. The two
reads below keep serving order counts, the recent-order feed and the agent
workflows built on them; their "revenue" is the older booked-gross figure
(order totals of non-cancelled, non-returned orders), not total sales.

### `getDashboardHomeSummary(db: Database, recentOrderLimit: number)`
One provider batch for Home:
- `stats.totalProducts` -- active, non-deleted products count
- `stats.totalCustomers` -- non-deleted customers count
- `stats.currentMonth` -- orders, revenue, orderGrowth (% vs last month), revenueGrowth, orderStatus breakdown (delivered, processing, shipping, cancelled)
- `stats.lastMonth` -- orders, revenue
- `recentOrders` -- the N most recent non-deleted orders (customerName, totalAmount, status, createdAt); `0` skips the query

The admin API omits every revenue value (`null`) unless the caller holds
`dashboard.analytics` ("View analytics"), and the order feed unless they
hold `orders.view`.

### `getDailyActivityData(db: Database, days: number)`
Returns per-day arrays for the last N days with zero-filling for days with no data:
- `date` (YYYY-MM-DD), `orders`, `revenue`, `newCustomers`

Dashboard reads emit generic Worker log events under `[dashboard-query]` with
`dashboard_query_completed`, `dashboard_query_retry`, or `dashboard_query_failed`.
Labels are `home_summary` and `daily_activity_{days}d`; payloads include duration and attempt counts only, not
order/customer values.

Dashboard SQL/index changes should be evidence-driven. On the current production
D1 shape, `recent_orders` with `deleted_at IS NULL` uses `orders_dashboard_agg_idx`,
`daily_activity_90d` uses `orders_dashboard_agg_idx` for orders and
`customers_dashboard_activity_idx` for customers, and remote query plans were
sub-millisecond on 2026-06-29. Avoid adding dashboard-specific write-path indexes
unless `[dashboard-query]` logs or remote `EXPLAIN QUERY PLAN` output show a real
slow/retry hotspot.

## Analytics and reports

The dashboard's Analytics page, its Reports and Home's sales numbers all come
from `reports/`. One file, `reports/sales-sql.ts`, defines which orders count
and how every money figure is measured; the overview and each report only
group those relations differently, so a number never means two things.

| File | Purpose |
|------|---------|
| `reports/sales-sql.ts` | The CTE chain every sales figure is built from (`so` → `rq`/`sl`/`sv`/`lv` → `lo`/`om`), measure lists, identity and prior-order probes, day/week/month bucket SQL |
| `reports/overview.ts` | `getAnalyticsOverview()`: one statement per period (current and comparison, run concurrently) |
| `reports/definitions.ts` | What each catalogued report reads (`REPORT_IMPLEMENTATIONS`) |
| `reports/engine.ts` | Sort validation, server-side paging with window totals, row reports, export iteration |
| `reports/service.ts` | Range/granularity resolution, access and capability gates, pages and CSV exports |
| `reports/csv.ts` | English CSV headings, enum words, decimal money, a totals row (shared spreadsheet-safe builder) |
| `reports/context.ts` | Per-request context: store currency and the unit-cost probe, read at most once; query timing logs |

The report catalog (ids, columns, types, default sorts) is
`@scalius/shared/analytics-reports`; periods, presets, comparisons and
buckets are `@scalius/shared/analytics-period`. The API serves them at
`/api/v1/admin/reports` (`dashboard.reports.list`, `.overview`, `.get`,
`.export`).

### Which orders count

- **Sales orders**: not deleted, placed in the range on the store calendar,
  in the store currency, and not `incomplete` (a hosted payment never
  finished: not an order yet) or `cancelled`. Every sales figure, rate and
  breakdown reads exactly these.
- **Cancelled orders** count only in the cancellation rate. Shopify books a
  cancellation as a sale plus a return; in a COD market most cancellations
  are unconfirmed orders that never shipped, and counting them would inflate
  gross sales and returns alike.
- **Other currencies**: the store is single-currency. Orders in any other
  currency are counted (`otherCurrencyOrders`, shown as a notice) and never
  summed. There is no conversion.
- **Test orders**: the schema has no test-order marker, so nothing can be
  excluded as a test; sandbox gateway orders look like real ones.

### Metric definitions

All money is integer minor units of the store currency until the API edge
converts it once (`fromMinor`). Per line of a sales order:

| Measure | Definition |
|---|---|
| Gross sales | `line_subtotal_minor` (unit price incl. property surcharges × quantity), less the line's included tax when prices include tax. Gift-card lines are excluded everywhere (a liability sold, not merchandise). |
| Discounts | The line's discount allocation (product and order discounts). Shipping discounts are not discounts: they reduce shipping. |
| Returns | A reversed order (status `returned` or `refunded`): the whole of gross − discounts. Otherwise the share of gross − discounts for the units in accepted returns (cases `approved`, `receiving`, `completed`, using `approved_quantity`, capped at the line quantity), floored to the minor unit. |
| Net sales | Gross − discounts − returns. |
| Taxes | Line tax less its returned share, plus shipping tax (order tax − every line's tax); none on a reversed order. |
| Shipping | Shipping charged − shipping discount (order discount − every line's discount) − included shipping tax; zero on a reversed order. |
| Total sales | Net sales + shipping + taxes. For an order without returns this is exactly its total (gift cards excepted). |
| Net items sold | Quantity − returned quantity. |
| Average order value | (Gross − discounts) ÷ orders (Shopify's AOV), rounded to the minor unit. |
| Refunded | Confirmed refunds (`order_payments` with `payment_type = 'refund'` and `status = 'refunded'`) on the period's sales orders. A money refund is not itemised, so it does not change returns (which are units); both are shown. |

Customers (identity = the customer record, else the phone a guest order
used):

- **New**: no sales order before the range starts. **Returning**: one or
  more before it.
- **Repeat purchase rate**: customers in the range with two or more sales
  orders through its end (an earlier order, or two inside it) ÷ customers.
- **New customers over time**: a customer is new in the bucket holding their
  first sales order ever (ties broken by order id).

Cash on delivery:

- **COD share**: sales orders with `payment_method = 'cod'` ÷ sales orders.
- **Returned to sender (RTS)**: a COD sales order `returned`/`refunded`
  whose COD tracking is not `collected` (it came back without the cash).
- **RTS rate**: RTS ÷ (RTS + COD orders delivered, i.e. cash collected or
  status `delivered`/`completed`). Parcels still out are left out, so recent
  unresolved parcels don't dilute it.
- **Cancellation rate**: cancelled ÷ placed (sales orders + cancelled).

### Attribution and time

- Everything is attributed to the **order's placement day** on the store
  calendar (Asia/Dhaka, UTC+6, no DST), including returns and refunds made
  later. A period's numbers therefore move as its orders resolve (a COD
  parcel returned next week lowers last week's net sales). This makes RTS,
  cancellation and net figures comparable across periods and reconcilable
  with the Orders list filtered by date. Shopify instead books a return on
  the return date; doing that here needs a dated sales ledger (see Rollups).
- Ranges are inclusive merchant days, at most 731. Buckets: days (ranges up
  to 92 days, so a whole overview fits one 64 KB agent response), Sunday
  weeks, or calendar months; computed in SQL from integer epoch days (no
  engine date functions). The comparison is the same number of days just
  before, or the same days a year earlier (29 February → 28 February).
- Snapshot reports (stock) read the store as it is now.

### Reports

| Report | Population and notes |
|---|---|
| Sales over time, by channel, payment method, city, delivery zone, location | Order-level measures. Delivery zone comes from the order's delivery rate (`shipping_method_id` → zone); `__no_delivery`, `__pickup`, `__unknown`, `__everywhere_else` name the rest. Location is the fulfilment location, else the default. |
| Sales by product, variant, category, brand | Line-level measures; category and brand are the product's today. Orders do not add up across rows. |
| Sales by collection | Today's membership (manual products, dynamic categories), at most 200 collections or 5,000 membership pairs (`collections_capped` note). Rows overlap. |
| Sales by discount | Per promotion and code: orders, discount given (allocations, incl. shipping), those orders' sales; discounts without a promotion (manual, app) in one `__manual` row. |
| Top customers | Needs `customers.view` (names and phones). First order is the first sales order ever. |
| New and returning customers | Counts only; no names. |
| Stock by location, Stock on hand | Live variants' `inventory_levels`; retail value at the variant price. |
| Low stock | Tracked SKUs needing restock (the inventory module's own rule), units sold in the last 30 days, days of cover = available × 30 ÷ sold. |
| Sell-through | Per tracked SKU: net units sold in the range ÷ (sold + on hand now), daily pace, days of cover. Starting stock isn't recorded, so the denominator uses stock now. |
| Payments, Refunds | Payment records of all orders placed in the range (incl. cancelled and unfinished ones: money facts), by method, kind and status. |
| Cash on delivery | COD sales orders by where the cash stands; outstanding = balance due on orders that can still be collected. |
| Gift cards | Liability now (active, unexpired balance), unusable balance, issued in the range by source, redeemed on the range's orders (net of releases). |
| Taxes | Kept tax by line tax class, plus shipping. |
| Delivery performance | Parcels of the range's orders by courier: delivered (incl. partial), returned, failed attempts, in transit; rates of parcels with an outcome; days order → booking; days booking → cash collected (COD; the store records no delivery timestamp). |
| Abandoned checkouts | Checkouts started in the range; recovered = a sales order from the same phone within 7 days of the buyer's last activity. Finished checkouts are deleted at once, so every row was abandoned; rows are kept 30 days (`abandoned_retention` note). |
| Profit by product | Only when `order_items.unit_cost_minor` exists (probed per request with a zero-row read; a missing column on D1, TursoDB or PostgreSQL means "not yet"). Uses the sale-time cost only, never today's; uncosted lines are left out of cost and profit, and coverage says how much was costed. |

### Access

The overview and reports need `dashboard.analytics` ("View analytics"),
which also shows sales on Home. Reports that name customers need
`customers.view` as well (checked by the route; the catalog marks them
unavailable). CSV exports are private, `no-store`, at most 10,000 rows and
16 MB, and carry only the report id, dates and sort in the request.

### Boundedness and performance

- One statement per period (overview) or per page (reports); the two
  overview periods run concurrently (two of D1's six connections). No
  statement binds more than a handful of parameters; collection membership
  travels as one JSON parameter.
- Orders are always entered through `orders_dashboard_agg_idx`
  (`deleted_at`, `created_at`); lines, payments, returns, COD tracking and
  parcels by their order indexes; prior orders per customer through
  `orders_customer_activity_idx` / `orders_customer_phone_idx`.
- D1 rejects compound SELECTs of more than five terms: the overview nests
  its groupings in two compounds.
- SQLite may inline a CTE into every reference, re-reading the period's
  orders each time. `so` and the overview's `ox` are `as materialized`
  (SQLite ≥ 3.35, PostgreSQL ≥ 12), and returns are joined by line rather
  than through a correlated subquery the planner repeated per reference.
- Report pages compute every group (window totals) and page with
  ORDER BY/LIMIT/OFFSET, at most 100 rows a page and 10,000 deep; an export
  is one read of up to 10,000 rows.
- `reports.scale.test.ts` loads a generated store and fails on any full
  scan of the order tables (or an orders index entered on `deleted_at`
  alone). Measured on node:sqlite (median of 3, a 100,000-order year,
  ~230,000 lines):

  | Read | Time |
  |---|---|
  | Overview, 30 days / 365 days (with comparison) | 0.36 s / 1.65 s |
  | Sales reports, 365 days (one page) | 0.6–0.9 s |
  | Inventory snapshots / sell-through | ≤ 35 ms / 0.39 s |
  | Finance, delivery, abandoned checkouts | 0.1–0.3 s |
  | CSV export of sales by variant (5,000 rows) | 0.84 s |

  D1 adds network and storage latency on top; rows read per year-long read
  are roughly the period's orders plus their lines (~0.35 M here).

### Rollups (proposed, not built: needs a migration)

Base tables serve stores up to about 100,000 orders a year interactively.
Past that, or for transaction-dated (Shopify-style) returns:

1. `analytics_order_facts` (one row per order: day, status class, every
   dimension, every order-level measure in minor units) and
   `analytics_line_facts` (one row per line: product, variant, category,
   brand, quantities, gross, discount, returned units/value, kept tax),
   recomputed by triggers in the same write as the order, its lines, its
   accepted returns and its payments, like `customer_order_stats`. Reports
   then read narrow indexed rows (`(day, …)`) with no joins or residual
   arithmetic: roughly 3–5× fewer rows touched.
2. `analytics_daily` (day × channel × payment method), maintained from the
   facts, for the overview totals and series: a year becomes ≤ 365 × a few
   rows.
3. For return-date attribution, an append-only `sales_ledger` (placement,
   accepted return, refund, cancellation events, each dated) instead of
   the order-date facts.

## Meta Conversions API

### Exported Functions (`meta.service.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `getCapiSettings` | `(db: Database, encryptionKey?: string)` | Read the `meta_conversions` settings document. Strictly decrypts the access token with the dedicated credential key and returns no access token for unreadable ciphertext. Returns `MetaConversionsSettings | null` (null before the first save). Typed catch blocks (`error: unknown`). |
| `logCapiEvent` | `(db: Database, logData, retentionHours = 12)` | Insert event log + trigger lazy cleanup via fire-and-forget `void performLogCleanup()`. Callers must pass redacted request payloads; the Meta CAPI route also redacts legacy stored payloads on admin reads. Uses `@paralleldrive/cuid2` for log IDs. |
| `performLogCleanup` | `(db: Database, retentionHours: number)` | Delete logs older than retention period. |
| `manualLogCleanup` | `(db: Database, retentionHours: number)` | Admin-triggered cleanup, returns `{ success: boolean; message: string }`. Uses `error instanceof Error` check in catch. |

### Meta Browser Event Cost Control

`POST /api/v1/meta/events` is for first-party storefront browser events only.
It validates the `eventSourceUrl` origin against `STOREFRONT_URL` before
provider work. When Meta returns a non-retryable provider/config failure, the
route opens the KV key `meta-capi:browser-events:circuit` for 15 minutes. While
that marker exists, later browser events return success-shaped skip responses
without rate-limit writes, D1 settings reads, Meta fetches, or log rows. Saving
Meta CAPI settings clears the marker so corrected credentials can retry
immediately.

Storefront layout enables browser Meta CAPI only after strict-reading the saved
access token with the dedicated `CREDENTIAL_ENCRYPTION_KEY`; unreadable
ciphertext is treated as not ready, not as a configured token. Browser event
dispatch uses one short unauthenticated direct POST with no hot retry loop, so
bad credentials or provider outages do not turn normal browsing into repeated
SDK retries.

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

- `@scalius/database` -- `analytics`, `products`, `customers`, `orders`, `settings`, `metaConversionsLogs`
- `@paralleldrive/cuid2` -- ID generation for Meta CAPI logs
- `nanoid` -- ID generation for analytics scripts
