# Analytics

The analytics domain manages third-party analytics scripts, checks provider readiness, serves the dashboard Home statistics, and runs the Analytics overview and reports. This document is for contributors, operators and coding agents. The Meta Conversions API is documented in the [Meta README](../../integrations/meta/README.md).

## Where it fits

- Layer L8. Imports from other domains: `collections`, `orders`, `products`, `settings` (`scripts/core-domain-graph.allow.json`).
- `index.ts` is the server API. `browser.ts` is the closed browser entry: `analytics.validation.ts` and `analytics-scripts.ts` (pure).
- Money is integer minor units until the API converts it once (`fromMinor`).

| File | Purpose |
|---|---|
| `analytics.service.ts` | Script create, list, update, toggle, trash, restore, delete |
| `analytics.validation.ts` | Zod schemas, per-provider shape checks, Cloudflare Web Analytics canonicalization |
| `analytics-scripts.ts` | `processAnalyticsScript()`, `shouldUsePartytown()`, `shouldInjectAnalyticsScript()` |
| `provider-health.ts` | Read-only readiness summary for the Provider Readiness card |
| `meta-pixel-parity.ts` | Compares the CAPI Pixel ID with active browser Pixel snippets |
| `dashboard.service.ts` | `getDashboardHomeSummary()`, `getDailyActivityData()` |
| `reports/` | The Analytics overview and reports |

## Analytics scripts

Table `analytics`: `id`, `name`, `type`, `is_active`, `use_partytown`, `config`, `location` (`head`, `body_start`, `body_end`), `revision`, `created_at`, `updated_at`, `deleted_at`. Types: `google_analytics`, `google_tag_manager`, `facebook_pixel`, `tiktok_pixel`, `cloudflare_web_analytics`, `custom`. Scripts are trusted admin code. The dashboard page is Settings > Integrations (`/admin/settings/integrations`).

### Lifecycle

- Every write after create sends `expectedRevision`. A stale revision returns 409.
- A new script is inactive by default. Creating an active script, or changing `isActive`, needs the `analytics.toggle` permission (`AnalyticsLifecycleAuthority.canToggle`).
- Trash deactivates a script. Restore brings it back inactive. Permanent delete works only on a trashed script.
- A second active script of the same non-custom type returns 409 unless the request sets `allowDuplicateProvider`.
- `listAnalyticsScripts` returns safe summaries (no `config`): id, name, type, flags, `revision`, the provider identifier (Cloudflare tokens are masked) and a readiness state (`ready`, `ready_to_activate`, `draft`, `blocked`, `trashed`). It uses `page` and `limit` paging (default 20, at most 100). The full snippet is only at `GET /api/v1/admin/analytics/{id}/source`.

### Checks on active scripts

The create, update and toggle paths run these checks. The public readers run them again before injection, so a legacy row cannot inject a bad snippet. Inactive drafts skip them.

| Type | An active script needs |
|---|---|
| `google_analytics` | A `G-` measurement ID and a `gtag` signal (not a GTM snippet) |
| `google_tag_manager` | A `GTM-` container ID (add the noscript iframe as a separate `body_start` custom snippet) |
| `facebook_pixel` | A numeric `fbq('init', '<id>')` |
| `tiktok_pixel` | `ttq.load('<id>')`, or the `events.js` URL with `sdkid=` |
| `cloudflare_web_analytics` | A site token, or the official beacon snippet |

Placeholder values (`G-XXXX`, `GTM-XXXX`, `PIXEL_ID`, `YOUR_..._PIXEL_ID`, `YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN`) are refused on an active script.

### Delivery

- Google Analytics, Tag Manager, Facebook Pixel and TikTok Pixel always run through Partytown (a web worker), even if a legacy row stores `use_partytown = false`. A `custom` script chooses (default on).
- Cloudflare Web Analytics runs on the main thread. The service canonicalizes a token or a pasted beacon to `<script type="module" fetchpriority="low" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"..."}'>`. The token must match `^[A-Za-z0-9_-]{8,128}$`. The dashboard defaults its location to `body_end`.
- The Partytown proxy (`/__ptproxy`, `apps/api/src/routes/partytown-proxy.ts`) accepts HTTPS targets only. The host must be in the merchant's CSP allow-list (Settings > Advanced > Trusted websites).
- `GET /api/v1/analytics/configurations` (public) and the storefront layout read return the active, injectable scripts. Both normalize Cloudflare snippets and rewrite Partytown scripts. They depend on `deps.analytics()` (kind `an`), so any write to `analytics` advances the dependency.

### Provider readiness

`getAnalyticsProviderHealth()` serves `GET /api/v1/admin/analytics/health`. It reads the `analytics` rows and the `meta_conversions` document. It reads the Meta access token strictly with `CREDENTIAL_ENCRYPTION_KEY`.

- Browser status per provider: `ready`, `draft`, `blocked`, `not_configured`.
- Server status: Meta CAPI is `ready`, `blocked` or `not_configured`. Google Analytics, Tag Manager and TikTok are browser only (`not_configured`). Cloudflare and `custom` are `not_applicable`.
- It never calls a provider, never sends a test event, and never returns a snippet or token.

`GET /api/v1/admin/settings/meta-conversions` adds a `pixelParity` diagnostic (warning only, never blocks a save). It compares the saved CAPI Pixel ID with the numeric IDs in `fbq('init', '<id>')` of active snippets. Statuses: `not_configured`, `invalid_capi_pixel_id`, `no_browser_pixel`, `unreadable_browser_pixel`, `ok`, `mismatch`, `multiple_browser_pixels`, `unavailable`. The parser ignores `window.fbq`, placeholder IDs, `fbq('track', ...)` and noscript images.

The storefront's browser events (`POST /api/v1/meta/events`) and their fail-closed circuit are in the [Meta README](../../integrations/meta/README.md).

## Routes

All paths start with `/api/v1/admin`.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /analytics` | `analytics.view` | List script summaries |
| `POST /analytics` | `analytics.create` | Create a script |
| `GET /analytics/health` | `analytics.view` | Provider readiness |
| `GET /analytics/{id}/source` | `analytics.edit` | Read one script with its snippet |
| `PUT /analytics/{id}` | `analytics.edit` | Update |
| `POST /analytics/{id}/toggle` | `analytics.toggle` | Activate or deactivate |
| `DELETE /analytics/{id}` | `analytics.edit` | Move to trash |
| `POST /analytics/{id}/restore` | `analytics.edit` | Restore from trash |
| `DELETE /analytics/{id}/permanent` | `analytics.edit` | Delete a trashed script |
| `GET /reports/overview` | `dashboard.analytics` | Overview for a range |
| `GET /reports` | `dashboard.analytics` | Report catalog |
| `GET /reports/{reportId}` | `dashboard.analytics` | One report page |
| `GET /reports/{reportId}/export` | `dashboard.analytics` | CSV export |
| `GET /dashboard/home-summary` | `dashboard.view` | Home counts and recent orders |
| `GET /dashboard/activity` | `dashboard.view` | Daily activity, 1 to 90 days |

## Home statistics

Home's sales numbers (total sales, orders, average order value, return-to-sender rate, trend) come from the Analytics overview for staff with `dashboard.analytics`. The two reads below serve order counts and the recent-order feed. Their "revenue" is the booked-gross figure: order totals of orders that are not cancelled or returned. It is not total sales.

- `getDashboardHomeSummary(db, recentOrderLimit)`: one provider batch with active product count, customer count, current-month and last-month orders and revenue, growth, an order-status breakdown, and the newest orders. A limit of `0` skips the order feed. The route uses 11.
- `getDailyActivityData(db, days)`: per merchant day `date`, `orders`, `revenue`, `newCustomers`, zero-filled. `days` is 1 to 90.
- The route returns every revenue value as `null` without `dashboard.analytics`, and an empty order feed without `orders.view`.
- Both reads retry transient D1 errors (150, 350, 750 ms) and log `[dashboard-query]` events with the label `home_summary` or `daily_activity_<days>d`, durations and attempts only.

## Analytics overview and reports

The Analytics page, its reports and Home's sales numbers all read `reports/`. `reports/sales-sql.ts` defines which orders count and how each money figure is measured. The overview and every report only group those relations, so a number has one meaning.

| File | Purpose |
|---|---|
| `reports/sales-sql.ts` | The CTE chain (`so` -> `rq`/`sl`/`sv`/`lv` -> `lo`/`om`), measures, customer probes, bucket SQL |
| `reports/overview.ts` | `getAnalyticsOverview()`: one statement per period, both periods run concurrently |
| `reports/definitions.ts` | What each catalogued report reads (`REPORT_IMPLEMENTATIONS`) |
| `reports/engine.ts` | Sort validation, paging with window totals, export iteration |
| `reports/service.ts` | Range and granularity, access gates, pages, CSV exports |
| `reports/csv.ts` | English headings, enum words, decimal money, totals row |
| `reports/context.ts` | Per-request context: store currency read once; query timing logs (`[analytics-query]`) |

The report catalog (ids, columns, types, default sorts) is `packages/shared/src/analytics-reports.ts`. Periods, presets, comparisons and buckets are `packages/shared/src/analytics-period.ts`.

### Which orders count

- **Sales orders:** not deleted, placed in the range on the store calendar, in the store currency, and not `incomplete` or `cancelled`. An `incomplete` order is a hosted payment the buyer never finished. Every sales figure, rate and breakdown reads these orders.
- **Cancelled orders** count only in the cancellation rate. Most COD cancellations never shipped. Counting them would inflate gross sales and returns alike.
- **Other currencies:** the store is single-currency. Orders in another currency are counted in `otherCurrencyOrders` and never summed. There is no conversion.
- **Test orders:** the schema has no test-order marker. Sandbox gateway orders count as real ones.

### Metric definitions

Per line of a sales order:

| Measure | Definition |
|---|---|
| Gross sales | `line_subtotal_minor`, less the line's included tax when prices include tax. Gift-card lines are excluded everywhere. |
| Discounts | The line's discount allocation. Shipping discounts reduce shipping instead. |
| Returns | A reversed order (`returned` or `refunded`): all of gross - discounts. Otherwise the share of gross - discounts for units in accepted return cases (`approved`, `receiving`, `completed`; `approved_quantity`, capped at the line quantity), floored to the minor unit. |
| Net sales | Gross - discounts - returns |
| Taxes | Line tax less its returned share, plus shipping tax (order tax - every line's tax). None on a reversed order. |
| Shipping | Shipping charged - shipping discount (order discount - every line's discount) - included shipping tax. Zero on a reversed order. |
| Total sales | Net sales + shipping + taxes |
| Net items sold | Quantity - returned quantity |
| Average order value | (Gross - discounts) / orders, rounded to the minor unit |
| Refunded | Confirmed refunds (`order_payments` with `payment_type = 'refund'` and `status = 'refunded'`) on the period's sales orders. A money refund is not itemised, so it does not change returns (which count units). |

Customers (identity is the customer record, else the phone a guest order used):

- **New:** no sales order before the range starts. **Returning:** one or more before it.
- **Repeat purchase rate:** customers with two or more sales orders through the range end, divided by customers in the range.
- **New customers over time:** a customer is new in the bucket of their first sales order ever (ties broken by order id).

Cash on delivery:

- **COD share:** COD sales orders / sales orders.
- **Returned to sender (RTS):** a COD sales order `returned` or `refunded` whose COD tracking is not `collected`.
- **RTS rate:** RTS / (RTS + COD orders delivered). Delivered means cash collected or status `delivered` or `completed`. Parcels still out are left out.
- **Cancellation rate:** cancelled / (sales orders + cancelled).

### Attribution and time

- Every figure belongs to the order's placement day on the store calendar (Asia/Dhaka, UTC+6, no DST). That includes later returns and refunds, so a period's numbers move as its orders resolve. This keeps RTS, cancellation and net figures comparable and reconcilable with the Orders list filtered by date.
- Booking a return on its own date would need a dated sales ledger. No such table exists.
- A range is at most 731 days. Day buckets work up to 92 days, so an overview fits one 64 KB agent response. Longer ranges use Sunday weeks or calendar months. Buckets are computed in SQL from integer epoch days.
- The comparison is the same number of days just before, or the same days a year earlier (29 February becomes 28 February).
- Presets: `today`, `yesterday`, `last_7_days`, `last_30_days`, `last_90_days`, `month_to_date`, `last_month`, `year_to_date`, `last_365_days`. A request without dates reads the last 30 days.
- Snapshot reports (stock) read the store as it is now.

### Reports

The catalog has 26 reports in six categories (`sales`, `customers`, `inventory`, `finance`, `operations`, `profit`).

| Report | Population and notes |
|---|---|
| Sales over time; by channel, payment method, city, delivery zone, location | Order-level measures. The delivery zone comes from the order's shipping method; `__no_delivery`, `__pickup`, `__unknown`, `__everywhere_else` name the rest. Location is the fulfilment location, else the default. |
| Sales by product, variant, category, brand | Line-level measures. Category and brand are the product's today. Rows do not add up to orders. |
| Sales by collection | Today's membership (manual products, dynamic categories). At most 200 collections or 5,000 membership pairs (`collections_capped` note). Rows overlap. |
| Sales by discount | Per promotion and code: orders, discount given (allocations, including shipping), those orders' sales. Discounts with no promotion (manual, app) form one `__manual` row. |
| Top customers | Needs `customers.view` (names and phones). |
| New and returning customers | Counts only. |
| Stock by location, Stock on hand | Live SKUs' `inventory_levels`. Retail value at the SKU price. |
| Low stock | Tracked SKUs that need restock (`buildNeedsRestockCondition` in `products/low-stock-policy.ts`), units sold in 30 days, days of cover. |
| Sell-through | Per tracked SKU: net units sold in the range / (sold + on hand now), daily pace, days of cover. Starting stock is not recorded, so the denominator uses stock now. |
| Payments, Refunds | Payment records of all orders placed in the range (including cancelled and unfinished), by method, kind and status. |
| Cash on delivery | COD sales orders by where the cash stands. Outstanding is the balance due on orders that can still be collected. |
| Gift cards | Liability now (active, unexpired balance), unusable balance, cards issued in the range by source, amount redeemed on the range's orders (net of releases). |
| Taxes | Kept tax by line tax class, plus shipping. |
| Delivery performance | Parcels of the range's orders by courier: delivered, returned, failed, in transit; rates of parcels with an outcome; days from order to booking; days from booking to cash collected (COD). |
| Abandoned checkouts | Checkouts started in the range. Recovered means a sales order from the same phone within 7 days of the buyer's last activity. Finished checkouts are deleted at once. Rows are kept 30 days (`abandoned_retention` note). |
| Profit by product | Uses `order_items.unit_cost_minor`, the SKU cost snapshotted by a trigger when the line is inserted (migration 0109). Lines without a cost are left out of cost and profit. Coverage shows how much was costed. |

### Access

- The overview and every report need `dashboard.analytics` ("View Analytics").
- Reports that name customers also need `customers.view`. Profit reports also need `products.view_costs`. The catalog marks a report unavailable with `customer_access` or `cost_access`, and the route returns 403 for it.
- A CSV export is private (`Cache-Control: private, no-store`), has at most 10,000 rows and 16 MB, and ends with a totals row. Headers `X-Export-Limited` and `X-Export-Truncated-By` tell when it stopped early. The request carries only the report id, dates and sort.

### Boundedness

- One statement per period (overview) or per page (report). The two overview periods run concurrently (two of D1's six connections). Collection membership travels as one JSON parameter.
- Orders are entered through `orders_dashboard_agg_idx`. Lines, payments, returns, COD tracking and parcels use their order indexes. Prior orders per customer use `orders_customer_activity_idx` and `orders_customer_phone_idx`.
- D1 rejects a compound SELECT of more than five terms. The overview nests its groupings in two compounds.
- `so` and the overview's `ox` are `as materialized`, so SQLite does not re-read the period's orders per reference. Returns join by line.
- A report page computes every group (window totals) and pages with `ORDER BY`, `LIMIT` and `OFFSET`. At most 100 rows a page and 10,000 deep. An export is one read of up to 10,000 rows. These lists use page numbers, not cursors.
- Reports read the base tables. No rollup or fact tables exist.
- `reports/reports.scale.test.ts` loads a generated store and fails on a full scan of `orders`, `order_items`, `order_payments`, `order_return_lines`, `cod_tracking`, `delivery_shipments` or `customers`, or on an orders index entered on `deleted_at` alone. For a measured run:

```bash
ANALYTICS_SCALE_ORDERS=100000 ANALYTICS_SCALE_RUNS=3 ANALYTICS_SCALE_OUT=/tmp/analytics-scale.json \
  pnpm exec vitest run packages/core/src/modules/analytics/reports/reports.scale.test.ts --testTimeout=600000
```
