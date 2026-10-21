# Scale and cost

Last reviewed: 2026-10-15

This document states what the platform costs per operation, how that cost is held in CI, and what it measures at catalogue scale on D1 and PostgreSQL. It is for contributors and operators. Page render budgets are in [STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md); the Workers plan limits are in [FREE-PLAN.md](./FREE-PLAN.md).

## What we count

D1 bills rows written at $1 per million and rows read at $0.001 per million, so a write is 1,000 times the price of a read. The cost of a store is the rows its operations write, multiplied by how often they run. D1 counts every index entry of a written row, so a row costs more than one.

| Counter | Where | Exact? |
| --- | --- | --- |
| Rows written | SQLite `total_changes()` per operation, triggers' writes included | Exact for table rows. D1 bills index entries too: the scale proof below measures D1's own `rows_written` for a checkout |
| Rows returned | The rows each statement returns | Exact |
| Rows read | Rows returned plus, for each full scan in a statement's query plan (triggers included), the scanned table's row count | An estimate: SQLite reports no rows read, and the estimate ignores `LIMIT`. The scale proof measures D1's `rows_read` |
| Full scans | `SCAN <table>` steps in the executed query plans | Exact and independent of table size: a new scan fails CI before the table is big enough to show it |

## The three CI gates

1. **Operation budgets.** `apps/api/src/free-plan-budget.test.ts` drives the real Worker through each key operation under both plan profiles and fails when D1 calls, statements, rows written, rows read or full scans grow past `apps/api/src/testing/free-plan-budgets.ts`. A steady state (the idle cron tick) also carries a mean budget. Row budgets carry 5% and one row of headroom, because a clock second or another test's event backlog moves them slightly; a row more per operation still fails. Regenerate with `pnpm free-plan:budget --record` and say why in the commit message when you raise one.
2. **Write scaling.** `apps/api/src/write-scaling.test.ts` asserts that a checkout's rows written grow linearly with its lines (3, 33 and 99 lines, the API maximum), that D1 round trips do not grow with the lines, that a trigger does per-row work (100 SKUs write the same rows per SKU as 10), and that a product or category page returns the same rows and runs no more full scans when the catalogue is 20 times the size.
3. **Trigger budget.** `packages/database/__tests__/trigger-budget.test.ts` bounds the longest trigger definition, the write statements of one trigger, the write statements all triggers of one table event run together, and the number of triggers per table, against `trigger-budget.json`. Synchronous projections cannot creep back into the write path unnoticed. Record a deliberate change with `TRIGGER_BUDGET_RECORD=1`.

## Recorded budgets

Free profile, measured on a seeded store (3-line orders; the others as listed). "Typical" is the mean of the warm runs; "worst run" is what the budget bounds, first-run fills included.

| Operation | D1 calls | Rows written, typical | Rows written, worst run | Rows read, est. | Full scans |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3-line order: checkout commit + after-response work | 34 | 100 | 100 | 68 | 26 |
| 20-line order | 38 | 480 | 563 | 205 | 56 |
| 99-line order | 34 | 2,146 | 2,547 | 843 | 205 |
| Order status change (pending to confirmed) | 32 | 16 | 16 | 21 | 1 |
| Order refund (cash, partly) | 41 | 18 | 18 | 27 | 2 |
| Admin order list (50 rows; cold RBAC reconciliation) | 9 | 0 | 0 | 1,255 | 4 |
| Product edit (admin save) | 24 | 34 | 521 | 152 | 27 |
| SKU stock change (+1 received) | 13 | 26 | 49 | 19 | 7 |
| Customer sign-up (code verify, new buyer) | 27 | 15 | 16 | 27 | 5 |
| Product page, cache miss | 21 | 0 | 0 | 129 | 15 |
| Category listing, cache miss | 5 | 0 | 0 | 110 | 6 |
| Search, cache miss | 6 | 0 | 0 | 726 | 17 |
| Product page, cache hit | 2 | 0 | 0 | 2 | 0 |
| Cron tick, idle store | 23 | 0 | 104 | 7,188 | 11 |

Read the cron row with care. A Free store ticks 1,440 times a day, so a row a tick is 1,440 rows written a day per store before any order: 100,000 stores would pay for 144 million rows a day, about $144, on idle alone. An idle tick writes 0 rows on both profiles; worst counters include first-run, hourly and daily work. The 2026-10-15 rerun includes first registration of three bundled Object types: 23 Free calls at worst, 62 Paid, with creation returning the row instead of rereading it. Until 2026-10-14 the Free tick wrote 2 rows a minute: Free's drain took two events at a time even when nobody subscribes, so any backlog (here the seed's 1,000 order events) trickled out over later ticks. A drain now settles up to 50 subscriber-less events in its one statement, and the seed settles its own history.

The status/refund, admin-list and cron rows were remeasured on both profiles on 2026-10-15 after the beta migration integration, meter correction and notification-read batching. Migration 0157 guards the order FTS update triggers so status and inventory-marker changes do not reindex unchanged customer text; this removes variable index-merge writes and brings status/refund writes to 16/18. The status/refund table rows follow the admin-list case; isolated cold costs are listed below. Other rows retain the earlier measurements. The first admin list includes the existing permission/role/grant reconciliation over initialized RBAC; the fixture now matches real first-admin setup. The old empty-RBAC fixture instead paid 12 calls, 366 statements and roughly 353 initialization writes. The new cold baseline pays 9 calls, 15 statements, no writes and 1,255 estimated reads; warm lists are unchanged at 3 calls, 53 rows read and no full scans. This increase is the corrected fixture measuring existing RBAC maintenance, not an order-list scan regression.

The rows-read column is an estimate (see the counter table), and it found a real regression on 2026-10-14: every render, validation snapshot and admin commit read the dependency clock with a full index scan of `cache_dep` (a `MAX` in a joined derived table; SQLite seeks only a scalar `MAX`), which added the table's row count to every page and write. The clock read is now a scalar subquery.

The 3-line order writes 100 table rows; D1 bills the scale proof's measured figure below, which includes index entries.

The earlier 71/80 status/refund counts were contaminated: the meter returned a mutable counter object, so the next run's unmetered checkout preparation changed the preceding result. Each measurement now returns a snapshot, includes its own after-response work, and enforces Free's 50-query ceiling without exceptions. First-admin fixture setup also seeds RBAC, matching the real setup route. Cold permission reconciliation still belongs to the measured request. With a cold RBAC marker, isolated status changes use 38 calls, 42 statements, 1,223 estimated reads and five full scans; isolated refunds use 47 calls, 53 statements, 1,229 estimated reads and six full scans. Both profiles agree. Normal ordered runs use 32/41 calls. Per-operation call budgets remain 50, and other budgets take the worst recorded normal or isolated cold counter.

## The scale proof

`node scripts/scale-proof.mjs --state <dir>` measures a store of 1,000,000 orders and about 150,000 SKUs (`scripts/catalog-scale-seed.mjs --profile huge`) on D1 (the local SQLite engine of workerd, through Miniflare) and on a temporary native PostgreSQL cluster loaded from the same data. It runs locally, takes about 20 minutes once the store exists (`--seed` builds it: about 30 minutes and 6 GB), never runs in CI, and removes its clone, its cluster and every process it started.

It measures:

- **Reads:** p50 and p95 over 20 timed runs of the main storefront reads, and the rows read by one metered run (D1 `meta.rows_read`; PostgreSQL tuples fetched).
- **Checkout throughput:** tax quote, commit and after-response work, at 1 and at 16 concurrent clients, with 3-line orders spread over many SKUs and with every order on one hot SKU. PostgreSQL serialization retries are counted; an order that fails is counted, never hidden.
- **Rows per order:** the rows one 3-line checkout reads and writes. On D1 this is D1's own accounting with index entries; on PostgreSQL it is the server's heap tuple counters.

Notes on the method. The API runs in-process (`fetchRuntimeApiApp`), so network and the Worker runtime are not in the figures; PostgreSQL goes through a connection pool that stands in for Hyperdrive, and both engines run on one machine with the clients. Compare engines and runs on the same machine, not against production latency.

<!-- scale-proof:start -->
### 1,000,000 orders, 156,244 SKUs

Measured 2026-10-21 at commit `eab6aa4d0` on Apple M1, 8 cores, 16 GB RAM, darwin 25.5.0, Node v24.21.0, 1-minute load average 4.8 at the end of the run.
Engines: D1 (Miniflare, workerd SQLite).

Store: 1,000,000 orders, 1,928,791 order lines, 50,000 products, 156,244 SKUs, 200,000 customers.

Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):

| Read | d1 p50 | d1 p95 | d1 rows read |
| --- | ---: | ---: | ---: |
| home page (storefront homepage) | 41 | 59 | 907 |
| product page | 89 | 132 | 8,677 |
| category listing, page 1 | 45 | 58 | 10,014 |
| category listing, page 40 | 29 | 35 | 8,261 |
| all products, newest, page 1 | 52 | 65 | 15,579 |
| search | 51 | 79 | 14,415 |
| product feed page | 98 | 113 | 12,786 |

Every D1 read is within the Free miss ceiling (25,000 rows, 200 misses a day).

Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:

| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d1 | 3 lines over many SKUs | 1 | 150 | 4.1 | 227 | 332 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 3 lines over many SKUs | 16 | 600 | 4.2 | 3,671 | 4,672 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 1 hot SKU | 1 | 150 | 4.9 | 193 | 264 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 1 hot SKU | 16 | 600 | 4.7 | 3,268 | 4,166 | 0 | 0 (0 Miniflare resets retried) |

Rows one 3-line checkout reads and writes (quote, commit, after-response work):

| Engine | Rows read | Rows written | Counted as |
| --- | ---: | ---: | --- |
| d1 | 30,924 | 190 | D1 `rows_read`/`rows_written`, index entries included (what D1 bills) |

### 50,000 orders, 156,244 SKUs

Measured 2026-10-21 at commit `523db6eaa` on Apple M1, 8 cores, 16 GB RAM, darwin 25.5.0, Node v24.21.0, 1-minute load average 6.3 at the end of the run.
Engines: PostgreSQL 15.17 (Homebrew).

Store: 50,000 orders, 96,854 order lines, 50,000 products, 156,244 SKUs, 200,000 customers.

Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):

| Read | postgres p50 | postgres p95 | postgres rows read |
| --- | ---: | ---: | ---: |
| home page (storefront homepage) | 19 | 27 | 483 |
| product page | 25 | 32 | 63,849 |
| category listing, page 1 | 24 | 25 | 2,951 |
| category listing, page 40 | 17 | 18 | 2,398 |
| all products, newest, page 1 | 22 | 24 | 7,742 |
| search | 53 | 54 | 234,745 |
| product feed page | 1,081 | 1,116 | 1,348,129 |

Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:

| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| postgres | 3 lines over many SKUs | 1 | 150 | 3.3 | 301 | 333 | 0 | 0 |
| postgres | 3 lines over many SKUs | 16 | 600 | 10.5 | 1,434 | 2,128 | 0 | 307 |
| postgres | 1 hot SKU | 1 | 150 | 3.4 | 288 | 326 | 0 | 0 |
| postgres | 1 hot SKU | 16 | 568 | 10.3 | 728 | 3,616 | 32 (HTTP 503) | 4494 |

Rows one 3-line checkout reads and writes (quote, commit, after-response work):

| Engine | Rows read | Rows written | Counted as |
| --- | ---: | ---: | --- |
| postgres | 53,138 | 55 | heap tuples read, inserted, updated, deleted; index entries not counted |
<!-- scale-proof:end -->

## Reading the results

How far to trust the numbers:

- **Rows read and written are exact and repeatable.** A checkout's reads follow the customers (200,000) and SKUs (156,244), not the orders.
- **Orders per second and latency are indicative.** The runs share a 16 GB laptop with the clients and with other jobs (the load average is in each block). Compare engines within one block, and compare blocks by rows, not by seconds.
- **D1 here is Miniflare, and the harness is most of a D1 checkout's time.** Its binding reaches workerd through the platform proxy, which costs about 2.6 ms of Node CPU per D1 call (measured: 3.1 ms a call, 200 calls). A checkout makes about 50 D1 calls, so about 150 ms of its 210 ms (one client) is the proxy; D1 itself spent 17 ms on the statements (D1 `meta.duration`) and the API about 45 ms of JS. Workers bindings have no such cost. A kept-alive connection the server has closed fails the next call with `ECONNRESET`; the harness retries it and counts it. D1 serializes writes, so 16 clients wait on one writer, and an order on a hot SKU also retries on the stock version check.
- **PostgreSQL here is a local server** with a connection pool standing in for Hyperdrive, analyzed after the load (a bulk load leaves no planner statistics; a running store has autovacuum's). The 1,000,000-order copy needs more disk than the proof's host had, so PostgreSQL runs on a smaller order history: 50,000 orders on 2026-10-21 (the same catalogue, 50,000 products and 156,244 SKUs, which is what the reads follow). The D1 block was measured at `eab6aa4d0`; its reads, measured again at `523db6eaa` after the subtree change of finding 10, read the same rows.

## Findings

The proof and the gates found these. Fixed ones keep their before and after; open ones are held by the gates from getting worse.

1. **Fixed: a checkout read 559,849 rows on D1 at 1,000,000 orders; it now reads 21,379 (26 times fewer).** Three reads scanned because SQLite plans without statistics on D1: the cart's product read and the reservation counter read walked the `(is_active, deleted_at)` product index (every live product, and every live product's SKUs) instead of the cart's id set, and the contact lookup put `deleted_at IS NULL` beside an `OR` of phone matches, so D1 walked a `deleted_at` index over all 200,000 customers. The event drain read every due outbox row before taking a few (the 1,000,000-order store carries a backlog of about 700,000 seed events: 695,000 rows a drain, 1,000,000 for the settle). Each is now index-driven, with plan guards (`checkout-read-plans.d1.test.ts`, `events.d1.test.ts`). The heaviest remaining reads are the automatic-promotion reads (1,390 rows each; the seed has 400 automatic promotions). On 2026-10-21 a checkout reads 30,924 rows: the promotion reads grew to 2,062 to 2,107 rows each with the promotion classes and conditions merged since; the checkout budgets (`order-3-line-commit`: 73 rows read) did not move. One client: 1.1 to 4.5 orders a second, bounded by the Miniflare proxy (above). On PostgreSQL the cart's SKU read (`product_id IN (...) OR id IN (...)`) was a sequential scan of every SKU; a checkout read 376,197 tuples and now 47,387, and one client went from 5.4 to 13.4 orders a second.
2. **Fixed: the product page read 118,253 rows on D1, the all-products listing 183,735 and a search 52,134; they now read 8,677, 15,579 and 14,415** (2026-10-21, same store; every read the proof measures is under the Free miss ceiling of 25,000). The product page's recommendations read a bounded candidate set (audit R2 B1). The listings read their page's ids from the buyer state first, through the order's own index, then the cards for those ids. A category subtree takes each published category's first `offset + limit + 1` rows through that category's index and cuts the page from their union. Facets of a plain category, subtree or brand page come from `product_facet_scope_counts` (migration 0174: exact product counts per category and per brand of every attribute value, option value, brand, category and whole-star rating, kept by triggers on the buyer state, the facet rows and the review stats), so they read no product rows at any size; plain shop-all reads `product_facet_public_counts` and each brand's and category's maintained count. A narrowed listing (search, a selection or a filter) counts attribute and option values live only up to `planLimits().lists.facetLiveProducts` products (Free 300, Paid 5,000). Shop-all narrowed by one value decides in SQL, from the value's maintained public count, whether to drive from the value's products or walk the order's index. Category pages went from 10,210 and 8,435 to 10,014 and 8,261; the feed page is unchanged (12,655 to 12,786). Limits left: a category subtree of many large categories sums its categories' facet rows (a 6,400-product root category of the seed reads about 28,000 rows; counts kept per subtree would remove it), and a narrowed scope past the live limit still reads its scope once for its total and price range.
3. **Fixed, with a limit: PostgreSQL checkout at 16 concurrent clients answered HTTP 500 for 45% (spread SKUs) and 75% (one hot SKU) of orders.** Two writers claiming the next stock version of one SKU collided as a unique violation (`23505`) the adapter could not retry: every ledger movement insert now reads its own `(variant, version)` key first, so PostgreSQL reports the race as a serialization failure (`40001`) and the adapter retries it on a fresh snapshot, where the stock-version check answers. The rest exhausted eight retries: checkouts still serialize on PostgreSQL (each takes the next order number with `max(order_number) + 1`, and SERIALIZABLE's page-level read locks make appends to the same index pages conflict), so the budget is now 32 attempts with the backoff capped at 50 ms, and a write that still loses is answered 503 `service_unavailable` (retry-safe; checkout is idempotent by its request id), never 500. Now: 0 failed with 500; 4.3% (spread) and 3.8% (hot SKU) answered 503, at 16.7 and 22.3 orders a second; no oversell, no stock-version gaps, one order number per order. Beta update (2026-10-15): migration 0154 adds a native PostgreSQL order-number sequence, and a focused 16-writer insert test passes. The throughput figures above predate that change. The 2026-10-21 run (50,000 orders): no 500s; 16 clients answered 503 for none of the spread-SKU orders and 5.3% (32 of 600) of the hot-SKU orders, at 10.5 and 10.3 orders a second (slower per order: finding 11).
4. **Fixed: the storefront homepage returned HTTP 500 on PostgreSQL** (`subquery in FROM must have an alias`: the card facts embedded a list's id query as an unaliased derived table). `homepage.postgres-native.test.ts` reads every homepage section kind on PostgreSQL.
5. **Fixed: the idle cron tick wrote 2 rows on the Free profile** (2,880 rows a day per store); it writes 0 (see Recorded budgets).
6. **Fixed: status/refund measurements included the next run's checkout preparation.** Snapshotting counters corrects the 71/80 report; both operations now enforce the per-invocation ceiling. Notification provider recovery also reads its settings timestamp and receipt history in one batch. Integrated measurements are 32 status-change calls and 41 refund calls on both profiles, with the strict 50-query ceiling enforced.
7. **The seed's order insert rate fell from about 700 to 185 a second as the table grew to 1,000,000 orders**: an insert does work that grows with the table (the plan of an `orders` insert scans `order_holds`).
8. **Fixed: the catalogue rebuild never finished a lap at 100,000 products on Free.** Every new rebuild request restarted the lap from the first product, and an inventory default change rebuilt every projection. A lap now keeps its position: a new request moves its end to the current position, so the lap finishes after one full turn (`apps/api/src/background/catalog.ts`); a change that only moves availability bands (the default low-stock level) runs a bands-only lap that recomputes the band in one indexed batch update per chunk (`planLimits().background.catalogBandRefreshChunk`: Free 1,000, Paid 5,000). A deploy rebuilds only when the projection definition changes, and the nightly pass checks a rotating window of products for drift (`catalogDriftCheckPerNight`: Free 450, Paid 9,000), repairs what it finds and requests a full lap.
9. **Fixed: in a market priced by its lists, price order, the price filter and the price range followed the base price** (`catalog/listing.ts`). They now follow the market's own card prices (`resolvePrice` over the buyable pool): the page merges the buyer state's base price stream with each live list's amount stream (index `price_list_prices_amount_idx`, migration 0174) and stops where both streams' bounds pass the page; a SKU with a live list price is filtered by its winning list amount. Such a listing pages by number and depends on `t:price_list_prices`. A market without live lists reads as before.
10. **Fixed: on PostgreSQL a category subtree page read 53,707 tuples (347 ms) for a 42-product category; it now reads 2,951 (24 ms).** The per-category first rows were a correlated `IN (… LIMIT n)`, which PostgreSQL cannot turn into a join: it walked all 50,000 buyer-state rows and ran the subquery once per category and row (100,000 runs). Each category's ids (and each market list's SKU ids for the market price order) now travel as one JSON list from a scalar subquery, expanded by `json_each`, a table function of the category row on both engines; D1 reads the same rows as before. `listing-scale.postgres-native.test.ts` and `market-price-order.postgres-native.test.ts` fail any plan that tests a correlated subquery as a filter.
11. **Open: PostgreSQL checkout runs at 3.3 orders a second with one client (p50 301 ms).** The 2026-10-14 run measured 13.4 (p50 70 ms) on a larger order history. Function timing (`track_functions = pl`) over 1,800 checkouts puts most of the time in the compatibility functions: 22.6 million `json_each` calls (144 s), 22.5 million `json_valid` and 25.5 million `json_type`, about 12,500 `json_each` calls an order. They come from the automatic-promotion eligibility reads (`promotion_effects`, `promotion_conditions`, `promotion_codes`), which open every effect's and collection's JSON config row by row through the PL/pgSQL shims. The catalogue triggers of migration 0174 are not among the costly functions. Open PostgreSQL reads: search 234,745 tuples (53 ms; the term matches 19,545 index rows, so PostgreSQL hashes the public buyer state), product page 63,849 (25 ms) and the feed page 1,348,129 (1.1 s), as before.
