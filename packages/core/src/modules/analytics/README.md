# Analytics

The analytics domain manages third-party analytics scripts, checks provider readiness, serves the dashboard Home statistics and runs the Analytics overview and reports. It is for contributors, operators and coding agents. The Meta Conversions API is in the [Meta README](../../integrations/meta/README.md).

## Where it fits

- Layer L9. Imports from other domains: `collections`, `markets`, `orders`, `products`, `settings` (`scripts/core-domain-graph.allow.json`).
- `index.ts` is the server API. `browser.ts` is the closed browser entry (`analytics.validation.ts` and `analytics-scripts.ts`, both pure).
- Money is integer minor units until the API converts it once (`fromMinor`).

## Analytics scripts

Table `analytics`. `location` is `head`, `body_start` or `body_end`. Types: `google_analytics`, `google_tag_manager`, `facebook_pixel`, `tiktok_pixel`, `cloudflare_web_analytics`, `custom`. Scripts are trusted admin code. The dashboard page is Settings > Integrations (`/admin/settings/integrations`).

### Lifecycle

- Every write after create sends `expectedRevision`. A stale revision returns 409.
- A new script is inactive. Creating an active script, or changing `isActive`, needs `analytics.toggle` (`AnalyticsLifecycleAuthority.canToggle`).
- Trash deactivates a script. Restore brings it back inactive. Permanent delete works only on a trashed script.
- A second active script of the same non-custom type returns 409 unless the request sets `allowDuplicateProvider`.
- `listAnalyticsScripts` returns safe summaries without `config`: the provider identifier (Cloudflare tokens masked) and a readiness state (`ready`, `ready_to_activate`, `draft`, `blocked`, `trashed`). It pages with `page` and `limit` (default 20, at most 100). The full snippet is only at `GET /api/v1/admin/analytics/{id}/source`.

### Checks on active scripts

The create, update and toggle paths run these checks. The public readers run them again before injection, so a legacy row cannot inject a bad snippet. Inactive drafts skip them.

| Type | An active script needs |
|---|---|
| `google_analytics` | A `G-` measurement ID and a `gtag` signal (not a GTM snippet) |
| `google_tag_manager` | A `GTM-` container ID (add the noscript iframe as a separate `body_start` custom snippet) |
| `facebook_pixel` | A numeric `fbq('init', '<id>')` |
| `tiktok_pixel` | `ttq.load('<id>')`, or the `events.js` URL with `sdkid=` |
| `cloudflare_web_analytics` | A site token, or the official beacon snippet |

An active script refuses placeholder values (`G-XXXX`, `GTM-XXXX`, `PIXEL_ID`, `YOUR_..._PIXEL_ID`, `YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN`).

### Delivery

- Google Analytics, Tag Manager, Facebook Pixel and TikTok Pixel always run through Partytown (a web worker), even if a legacy row stores `use_partytown = false`. A `custom` script chooses (default on).
- Cloudflare Web Analytics runs on the main thread. The service canonicalizes a token or a pasted beacon to the platform-generated snippet (`src` `https://static.cloudflareinsights.com/beacon.min.js`, `data-cf-beacon='{"token":"..."}'`). The token must match `^[A-Za-z0-9_-]{8,128}$`.
- The Partytown proxy (`/__ptproxy`, `apps/api/src/routes/partytown-proxy.ts`) accepts HTTPS targets only. The host must be in the merchant's CSP allow-list (Settings > Advanced > Trusted websites).
- `GET /api/v1/analytics/configurations` (public) and the storefront layout read return the active, injectable scripts, with Cloudflare snippets normalized and Partytown scripts rewritten. They depend on `deps.analytics()` (kind `an`), so any write to `analytics` advances the dependency.

### Provider readiness

`getAnalyticsProviderHealth()` serves `GET /api/v1/admin/analytics/health`. It reads the `analytics` rows and the `meta_conversions` document, and reads the Meta access token strictly with `CREDENTIAL_ENCRYPTION_KEY`. It never calls a provider, sends a test event or returns a snippet or token.

- Server status: Meta CAPI is `ready`, `blocked` or `not_configured`. Google Analytics, Tag Manager and TikTok are browser only (`not_configured`). Cloudflare and `custom` are `not_applicable`.

`GET /api/v1/admin/settings/meta-conversions` adds a `pixelParity` diagnostic (a warning, never a block on save). It compares the saved CAPI Pixel ID with the numeric IDs in `fbq('init', '<id>')` of active snippets (statuses: `meta-pixel-parity.ts`). The parser ignores `window.fbq`, placeholder IDs, `fbq('track', ...)` and noscript images.

The storefront's browser events (`POST /api/v1/meta/events`) and their fail-closed circuit are in the [Meta README](../../integrations/meta/README.md).

## Tracking consent and server events

Audit spec §3.10 (slice S4). The rules live in `@scalius/shared/tracking-consent`; the settings documents and senders in `packages/core/src/integrations/tracking/` (signals, deliveries, settings), `integrations/ga4/` and `integrations/tiktok/`.

### Consent

- **Regime.** A market that sells to any EEA, UK or Swiss country is opt-in: nothing that needs consent runs until the buyer agrees. Other markets follow the `tracking_consent` document's `otherRegions`: `notice` (default; tags run until the buyer refuses), `opt_in` or `link_only` (no banner, only "Your privacy choices"). The page's regime is its market's (URL presence); a server sender uses the order's shipping (else billing) country.
- **Categories.** Analytics: GA4 and Tag Manager. Marketing: Meta and TikTok pixels and their server events. Sale of data: sharing with ad partners (Meta Limited Data Use, TikTok `limited_data_use` when refused). Global Privacy Control (`Sec-GPC`, `navigator.globalPrivacyControl`) denies marketing and sale of data.
- **Storefront.** `components/consent/`: the head boot script (folded into the runtime globals, before Partytown) reads the `scalius_consent` cookie (`v1-a<0|1>-m<0|1>-s<0|1>`, 180 days) and GPC, publishes `window.__scaliusConsent`, pushes Google Consent Mode v2 defaults (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`, `wait_for_update: 500`) before any tag, and marks `<html data-consent-banner>` so the banner paints with the page. Meta and TikTok snippets (and custom snippets that load them) render inert (`type="text/plain" data-scalius-consent="marketing"`, their `<noscript>` pixel removed) and start when marketing is granted; revoking calls `fbq('consent','revoke')` and `ttq.revokeConsent()`. Click ids from the landing URL stay in memory until marketing is granted. The HTML never depends on the cookie, so pages stay cached per market (`set:tracking_consent:document`).
- **Banner.** Code-owned, theme-tokened, fixed at the bottom (no layout shift, small text so it is never the LCP element), keyboard reachable, en and bn copy. It shows only when a tag or a server destination needs consent.

### Server events

| Funnel step | Meta (Pixel / CAPI) | GA4 (gtag / Measurement Protocol) | TikTok (ttq / Events API) | Event id |
|---|---|---|---|---|
| Product view | ViewContent B+S | view_item B | ViewContent B+S | shared random |
| List view | ViewContent B (product_group) | view_item_list B | none | shared random |
| Search | Search B+S | search B | Search B+S | shared random |
| Add to cart | AddToCart B+S | add_to_cart B | AddToCart B+S | shared random |
| Begin checkout | InitiateCheckout B+S | begin_checkout B | InitiateCheckout B+S | shared random |
| Payment info | AddPaymentInfo B+S | add_payment_info B | AddPaymentInfo B+S | shared random |
| Purchase | Purchase B + S (outbox) | purchase B + S (deliveries) | Purchase B + S (deliveries) | `Purchase:<orderId>`; GA4 `transaction_id` |
| Refund | none | refund S | none | `refund:<paymentId>` |
| Newsletter | Lead B+S | generate_lead B | SubmitForm B+S | shared random |
| Account created | CompleteRegistration B+S | sign_up B | CompleteRegistration B+S | `CompleteRegistration:<customerId>` |

B: browser, S: server. TikTok's purchase is `Purchase` (`CompletePayment` is retired: "About Standard Events in TikTok Ads Manager", ads.tiktok.com/help/article/standard-events-parameters). Browser S events go through `POST /api/v1/meta/events`, which sends to Meta and, under its own circuit (`tiktok-events:browser-events:circuit`), to TikTok; both need marketing consent in the browser. TikTok's pixel identifies the buyer (`ttq.identify` with SHA-256 email, E.164 phone and customer id) before the purchase.

- **Snapshot.** The checkout commit writes `order_tracking_signals` in the order batch when Meta CAPI, GA4 MP or TikTok Events API is on: the consent snapshot, `fbp`, `fbc`, `_ttp`, `ttclid`, the `_ga` client and session ids, `gclid`, IP and user agent (advertising ids, IP and UA only with marketing, GA ids only with analytics). The storefront's checkout proxy reads them from the buyer's own request. It is not an event fact, and the cron purges it after 8 days. Cost: one statement and one row; two statements and up to three rows when GA4 or TikTok is owed a purchase (same D1 call).
- **Meta Purchase** (outbox) adds fbp, fbc, IP and UA to the hashed contact, reports the commit time as `event_time`, and is skipped (`consent_denied`) when the snapshot denies marketing. An order without a snapshot follows its country's default.
- **GA4 and TikTok deliveries** (`tracking_deliveries`, unique per destination and dedup key): the purchase is sent once per order after the commit (a hosted payment after its confirmation, else the hourly re-check), retried with backoff by the cron's `tracking_outbox_flush` job (one D1 call with Meta's due rows when idle). A confirmed refund of an order whose GA4 purchase was sent queues the GA4 refund (trigger on `order_payments`). GA4 uses the `_ga` client id (else a stable per-order id), `session_id`, `user_id`, `timestamp_micros` within 72 hours and `consent.ad_user_data`/`ad_personalization`.
- **Settings and test mode.** `GET`/`POST /api/v1/admin/settings/tracking` (`dashboard.tracking.get`/`update`; `analytics.view`/`analytics.edit`): the banner, GA4 (`measurementId`, `apiSecret` encrypted, `debugMode` sends to the validation server) and TikTok (`pixelCode`, `accessToken` encrypted, `testEventCode`). Meta's test event code stays in `meta_conversions`.
- **Health.** `GET /api/v1/admin/analytics/tracking-health` (`dashboard.analytics.tracking_health`, `analytics.view`): the last 24 hours per destination (configured, test mode, events sent/failed/skipped/pending, purchases skipped by consent, match-signal counts, latest error) and across orders (consent outcomes, match-signal coverage in percent). Counts only. `POST /api/v1/admin/analytics/test-event` (`dashboard.analytics.send_test_event`, `analytics.edit`) sends one test event: Meta and TikTok under their test event code, GA4 to the validation server.

## Routes

All paths start with `/api/v1/admin`.

| Method and path | Permission |
|---|---|
| `GET /analytics`, `GET /analytics/health` | `analytics.view` |
| `POST /analytics` | `analytics.create` |
| `GET /analytics/{id}/source`, `PUT /analytics/{id}` | `analytics.edit` |
| `POST /analytics/{id}/toggle` | `analytics.toggle` |
| `DELETE /analytics/{id}` (trash), `POST /analytics/{id}/restore`, `DELETE /analytics/{id}/permanent` | `analytics.edit` |
| `GET /analytics/tracking-health` | `analytics.view` |
| `POST /analytics/test-event` | `analytics.edit` |
| `GET /settings/tracking`, `POST /settings/tracking` | `analytics.view`, `analytics.edit` |
| `GET /reports/overview`, `GET /reports`, `GET /reports/{reportId}`, `GET /reports/{reportId}/export` | `dashboard.analytics` |
| `GET /dashboard/home-summary`, `GET /dashboard/activity` (1 to 90 days) | `dashboard.view` |

## Home statistics

Home's sales numbers (total sales, orders, average order value, return-to-sender rate, trend) come from the Analytics overview for staff with `dashboard.analytics`. The two reads below serve order counts and the recent-order feed. Their "revenue" is the booked-gross figure: the shop-currency totals (`total_shop_minor`, the order money chain) of orders that are not cancelled or returned. They never sum presentment totals in mixed currencies.

- `getDashboardHomeSummary(db, recentOrderLimit, timeZone)`: one provider batch with product and customer counts, current-month and last-month orders and revenue, growth, an order-status breakdown and the newest orders. A limit of `0` skips the order feed. The route uses 11.
- `getDailyActivityData(db, days, timeZone)`: per merchant day `date`, `orders`, `revenue`, `newCustomers`, zero-filled. `days` is 1 to 90.
- The route returns every revenue value as `null` without `dashboard.analytics`, and an empty order feed without `orders.view`.

## Analytics overview and reports

The Analytics page, its reports and Home's sales numbers all read `reports/`. `reports/sales-sql.ts` defines report scopes and grouping. Its line/order monetary expressions come from `@scalius/database/analytics-sales-sql`, shared with the overview projection, so money has one definition across live reports and stored facts.

The report catalog (ids, columns, types, default sorts) is `packages/shared/src/analytics-reports.ts`. Periods, presets, comparisons and buckets are `packages/shared/src/analytics-period.ts`.

### Which orders count

- **Sales orders:** not deleted, placed in the range on the store calendar, presented and reported in the store currency (`currency_code` and `shop_currency`), and not `incomplete` or `cancelled`. An `incomplete` order is a hosted payment the buyer never finished. Every sales figure, rate and breakdown reads these orders.
- **Cancelled orders** count only in the cancellation rate. Most COD cancellations never shipped, so counting them would inflate gross sales and returns alike.
- **Other currencies:** the store is single-currency. Orders in another currency count in `otherCurrencyOrders` and are never summed or converted. Report measures are presentment line amounts; they move to shop amounts before a second currency is enabled (Markets step 6).
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

Customers (identity is the customer record; an order without one is its own customer):

- **New:** no sales order before the range starts. **Returning:** one or more before it.
- **Repeat purchase rate:** customers with two or more sales orders through the range end, divided by customers in the range.
- **New customers over time:** a customer is new in the bucket of their first sales order ever (ties broken by order id).

Cash on delivery:

- **COD share:** COD sales orders / sales orders.
- **Returned to sender (RTS):** a COD sales order `returned` or `refunded` whose COD tracking is not `collected`.
- **RTS rate:** RTS / (RTS + COD orders delivered). Delivered means cash collected or status `delivered` or `completed`. Parcels still out are left out.
- **Cancellation rate:** cancelled / (sales orders + cancelled).

### Attribution and time

- Every figure belongs to the order's placement day on the store calendar: the store time zone, daylight saving included ([STORE-DEFAULTS.md](../../../../../docs/STORE-DEFAULTS.md)). That includes later returns and refunds, so a period's numbers move as its orders resolve, and they reconcile with the Orders list filtered by date.
- A range is at most 731 days. Day buckets work up to 92 days, so an overview fits one 64 KB agent response. Longer ranges use weeks (starting on the store country's CLDR first day: Sunday in Bangladesh, `docs/STORE-DEFAULTS.md`) or calendar months.
- The comparison is the same number of days just before, or the same days a year earlier (29 February becomes 28 February).
- A request without dates reads the last 30 days (presets: `analytics-period.ts`). Snapshot reports (stock) read the store as it is now.

### Reports

The catalog has 26 reports in six categories (`sales`, `customers`, `inventory`, `finance`, `operations`, `profit`). Populations that carry a rule:

| Report | Population and notes |
|---|---|
| Sales over time; by channel, payment method, city, delivery zone, location | Order-level measures. The delivery zone comes from the order's shipping method; `__no_delivery`, `__pickup`, `__unknown`, `__everywhere_else` name the rest (`__everywhere_else`: a delivery rate without a zone, which exists only from before migration 0114). Location is the fulfilment location, else the default. |
| Sales by product, variant, category, brand | Line-level measures. Category and brand are the product's today. Rows do not add up to orders. |
| Sales by collection | Today's membership (manual products, dynamic categories). At most 200 collections or 5,000 membership pairs (`collections_capped` note). Rows overlap. |
| Sales by discount | Per promotion and code, including shipping discounts. Discounts with no promotion (manual, app) form one `__manual` row. |
| Top customers | Needs `customers.view` (names and phones). |
| Stock by location, Stock on hand | Live SKUs' `inventory_levels`, retail value at the SKU price. |
| Low stock | Tracked SKUs that need restock (`buildNeedsRestockCondition` in `products/low-stock-policy.ts`). |
| Sell-through | Net units sold in the range / (sold + on hand now). Starting stock is not recorded, so the denominator uses stock now. |
| Payments, Refunds | Payment records of all orders placed in the range, including cancelled and unfinished. |
| Cash on delivery | COD sales orders by where the cash stands. Outstanding is the balance due on orders that can still be collected. |
| Gift cards | Liability now (active, unexpired balance), unusable balance, cards issued in the range, amount redeemed on the range's orders (net of releases). |
| Taxes | Kept tax by line tax class, plus shipping. |
| Delivery performance | Parcels of the range's orders by courier. Rates use parcels with an outcome. |
| Abandoned checkouts | Checkouts started in the range. Recovered means a sales order from the same phone within 7 days of the buyer's last activity. Finished checkouts are deleted at once. Rows are kept 30 days (`abandoned_retention` note). |
| Profit by product | Uses `order_items.unit_cost_minor`, the SKU cost a trigger snapshots when the line is inserted (migration 0109). Lines without a cost are left out of cost and profit. Coverage shows how much was costed. |

### Access

- The overview and every report need `dashboard.analytics` ("View Analytics").
- Reports that name customers also need `customers.view`. Profit reports also need `products.view_costs`. The catalog marks a report unavailable with `customer_access` or `cost_access`, and the route returns 403 for it.
- A CSV export is private (`Cache-Control: private, no-store`), has at most 10,000 rows and 16 MB, and ends with a totals row. Headers `X-Export-Limited` and `X-Export-Truncated-By` tell when it stopped early. The request carries only the report id, dates and sort.

### Boundedness

- The overview reads daily totals once to select customer paths. When both periods use customer summaries, one statement shares their covering customer scan and returns tagged rows to the existing period mapper. Other requests run one statement per period, concurrently using at most two of D1's six connections. Detailed reports use one statement per page. Collection membership travels as one JSON parameter.
- Live reports materialize `so`; the overview materializes only exact boundary facts and grouped summaries, without reopening the order ledger.
- D1 rejects a compound SELECT of more than five terms, so the overview nests its groupings in two compounds.
- A report page computes every group (window totals) and pages with `ORDER BY`, `LIMIT` and `OFFSET`: at most 100 rows a page and 10,000 deep. An export is one read of up to 10,000 rows. These lists use page numbers, not cursors.
- Sales over time reads the same quarter-hour totals and exact facts as the overview, preserving merchant-day grouping, zero-fill, paging and CSV. Other detailed reports read base tables.
- The projection (`@scalius/database/analytics-rollup`, migration 0146): one `analytics_order_facts` row per order holds the order's own state (eligibility, FX rate and shift, converted shipping/discount/tax, refunds, COD collection) and running sums of its lines, each line converted on its own. A write moves only the sums its changed rows feed: O(changed rows), never a whole-order recompute (only an FX rate or tax-mode change reconverts every line). Measures derive on read (`analyticsFactMeasureSql`), so one formula serves readers, sealing and drift checks.
- `analytics_sales_buckets` (full UTC days by dimension, quarter-hour totals) count only for days in `analytics_sealed_days`. The `analytics_seal` sweep builds finished days from their facts; a later write to a fact of a sealed day deletes its seal, and readers take unsealed days from facts. No request writes a bucket, so concurrent checkouts share no projection row on any provider.
- Customer counts stay exact: the range's identities come from the covering date index, and each one's earlier sale is one probe of the identity index. Identity is the customer record, else the order itself: no phone number reaches the projection, and orders without a customer never merge.
- `maintainDerivedProjections` (API `scheduled/derived-projections.ts`, nightly and the `dashboard.derived_projections.maintain` operation) compares a sample of facts, sealed days, recommendation pairs and inbox counters with their sources and repairs drift; `rebuild` walks every order in id chunks.
- Monetary SQL explicitly preserves half-away FX rounding and integer partial-return division on all providers (`round(expr, 0)` and integer accepted-quantity sums).
- `reports/reports.scale.test.ts` loads a generated store and fails on a full scan of `orders`, `order_items`, `order_payments`, `order_return_lines`, `cod_tracking`, `delivery_shipments` or `customers`, or on an orders index entered on `deleted_at` alone. For a measured run:

```bash
ANALYTICS_SCALE_ORDERS=100000 ANALYTICS_SCALE_RUNS=3 ANALYTICS_SCALE_OUT=/tmp/analytics-scale.json \
  pnpm exec vitest run packages/core/src/modules/analytics/reports/reports.scale.test.ts --testTimeout=600000
```

The overview gate checks bounded fact/bucket plans and exact mutation parity with the pre-rollup SQLite source query. Its opt-in benchmark writes one disposable file-backed store, reports backfill time/storage, reopens SQLite for each first read, checks month/year comparisons, and measures 99-line writes plus a 500-line stress case (one fact write per line):

```bash
ANALYTICS_SCALE_ORDERS=1000000 ANALYTICS_SCALE_RUNS=1 ANALYTICS_SCALE_OUT=/tmp/analytics-rollup.json \
  pnpm exec vitest run packages/core/src/modules/analytics/reports/overview-rollup.benchmark.test.ts --maxWorkers=1
```

Fresh SQLite connections clear the connection page cache; the OS cache remains uncontrolled. The <=300 ms SQL gate does not replace first-request Worker HTTP timings or the browser harness.
