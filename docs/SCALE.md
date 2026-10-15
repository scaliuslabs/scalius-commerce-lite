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
| Order status change (pending to confirmed) | 32 | 32 | 32 | 21 | 1 |
| Order refund (cash, partly) | 41 | 51 | 68 | 27 | 2 |
| Admin order list (50 rows; cold RBAC reconciliation) | 9 | 0 | 0 | 1,255 | 4 |
| Product edit (admin save) | 24 | 34 | 521 | 152 | 27 |
| SKU stock change (+1 received) | 13 | 26 | 49 | 19 | 7 |
| Customer sign-up (code verify, new buyer) | 27 | 15 | 16 | 27 | 5 |
| Product page, cache miss | 21 | 0 | 0 | 129 | 15 |
| Category listing, cache miss | 5 | 0 | 0 | 110 | 6 |
| Search, cache miss | 6 | 0 | 0 | 726 | 17 |
| Product page, cache hit | 2 | 0 | 0 | 2 | 0 |
| Cron tick, idle store | 21 | 0 | 103 | 7,187 | 10 |

Read the cron row with care. A Free store ticks 1,440 times a day, so a row a tick is 1,440 rows written a day per store before any order: 100,000 stores would pay for 144 million rows a day, about $144, on idle alone. An idle tick writes 0 rows on both profiles; the worst run is the first tick of the hour, which pays the hourly and daily work. Until 2026-10-14 the Free tick wrote 2 rows a minute: Free's drain took two events at a time even when nobody subscribes, so any backlog (here the seed's 1,000 order events) trickled out over later ticks. A drain now settles up to 50 subscriber-less events in its one statement, and the seed settles its own history.

The status/refund and admin-list rows were remeasured on both profiles on 2026-10-15 after the beta migration integration, meter correction and notification-read batching. The status/refund table rows follow the admin-list case; isolated cold costs are listed below. Other rows retain the earlier measurements. The first admin list includes the existing permission/role/grant reconciliation over initialized RBAC; the fixture now matches real first-admin setup. The old empty-RBAC fixture instead paid 12 calls, 366 statements and roughly 353 initialization writes. The new cold baseline pays 9 calls, 15 statements, no writes and 1,255 estimated reads; warm lists are unchanged at 3 calls, 53 rows read and no full scans. This increase is the corrected fixture measuring existing RBAC maintenance, not an order-list scan regression.

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

Measured 2026-10-14 at commit `590fcbbbd` on Apple M1, 8 cores, 16 GB RAM, darwin 25.5.0, Node v24.21.0, 1-minute load average 3 to 6 during the runs.
Engines: D1 (Miniflare, workerd SQLite).

Store: 1,000,000 orders, 1,928,791 order lines, 50,000 products, 156,244 SKUs, 200,000 customers.

Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):

| Read | d1 p50 | d1 p95 | d1 rows read |
| --- | ---: | ---: | ---: |
| home page (storefront homepage) | 39 | 48 | 908 |
| product page | 100 | 135 | 118,253 |
| category listing, page 1 | 50 | 72 | 10,210 |
| category listing, page 40 | 33 | 37 | 8,435 |
| all products, newest, page 1 | 76 | 88 | 183,735 |
| search | 69 | 85 | 52,134 |
| product feed page | 103 | 247 | 12,655 |

Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:

| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d1 | 3 lines over many SKUs | 1 | 150 | 4.5 | 213 | 314 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 3 lines over many SKUs | 16 | 600 | 4.7 | 3,414 | 3,658 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 1 hot SKU | 1 | 150 | 5.2 | 183 | 253 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 1 hot SKU | 16 | 600 | 5.4 | 2,930 | 3,317 | 0 | 0 (0 Miniflare resets retried) |

Rows one 3-line checkout reads and writes (quote, commit, after-response work):

| Engine | Rows read | Rows written | Counted as |
| --- | ---: | ---: | --- |
| d1 | 21,379 | 373 | D1 `rows_read`/`rows_written`, index entries included (what D1 bills) |

### 252,128 orders, 156,244 SKUs

Measured 2026-10-14 at commit `590fcbbbd` on Apple M1, 8 cores, 16 GB RAM, darwin 25.5.0, Node v24.21.0, 1-minute load average 3 to 6 during the runs.
Engines: PostgreSQL 15.17 (Homebrew).

Store: 252,128 orders, 486,938 order lines, 50,000 products, 156,244 SKUs, 201,465 customers.

Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):

| Read | postgres p50 | postgres p95 | postgres rows read |
| --- | ---: | ---: | ---: |
| home page (storefront homepage) | 19 | 20 | 484 |
| product page | 169 | 192 | 122,897 |
| category listing, page 1 | 24 | 25 | 2,223 |
| category listing, page 40 | 17 | 19 | 1,701 |
| all products, newest, page 1 | 59 | 75 | 160,566 |
| search | 149 | 169 | 194,209 |
| product feed page | 1,109 | 1,243 | 1,348,107 |

Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:

| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| postgres | 3 lines over many SKUs | 1 | 150 | 13.4 | 70 | 102 | 0 | 0 |
| postgres | 3 lines over many SKUs | 16 | 574 | 16.7 | 323 | 2,701 | 26 (HTTP 503) | 4490 |
| postgres | 1 hot SKU | 1 | 150 | 14.2 | 65 | 99 | 0 | 0 |
| postgres | 1 hot SKU | 16 | 577 | 22.3 | 223 | 2,127 | 23 (HTTP 503) | 3911 |

Rows one 3-line checkout reads and writes (quote, commit, after-response work):

| Engine | Rows read | Rows written | Counted as |
| --- | ---: | ---: | --- |
| postgres | 47,387 | 45 | heap tuples read, inserted, updated, deleted; index entries not counted |
<!-- scale-proof:end -->

## Reading the results

How far to trust the numbers:

- **Rows read and written are exact and repeatable.** A checkout's reads follow the customers (200,000) and SKUs (156,244), not the orders.
- **Orders per second and latency are indicative.** The runs share a 16 GB laptop with the clients and with other jobs (the load average is in each block). Compare engines within one block, and compare blocks by rows, not by seconds.
- **D1 here is Miniflare, and the harness is most of a D1 checkout's time.** Its binding reaches workerd through the platform proxy, which costs about 2.6 ms of Node CPU per D1 call (measured: 3.1 ms a call, 200 calls). A checkout makes about 50 D1 calls, so about 150 ms of its 210 ms (one client) is the proxy; D1 itself spent 17 ms on the statements (D1 `meta.duration`) and the API about 45 ms of JS. Workers bindings have no such cost. A kept-alive connection the server has closed fails the next call with `ECONNRESET`; the harness retries it and counts it. D1 serializes writes, so 16 clients wait on one writer, and an order on a hot SKU also retries on the stock version check.
- **PostgreSQL here is a local server** with a connection pool standing in for Hyperdrive, analyzed after the load (a bulk load leaves no planner statistics; a running store has autovacuum's). The 1,000,000-order copy needs more disk than the proof's host had, so PostgreSQL runs on the 250,000-order store (`--profile huge --orders 250000`; the store holds the proof's own orders from earlier runs too).

## Findings

The proof and the gates found these. Fixed ones keep their before and after; open ones are held by the gates from getting worse.

1. **Fixed: a checkout read 559,849 rows on D1 at 1,000,000 orders; it now reads 21,379 (26 times fewer).** Three reads scanned because SQLite plans without statistics on D1: the cart's product read and the reservation counter read walked the `(is_active, deleted_at)` product index (every live product, and every live product's SKUs) instead of the cart's id set, and the contact lookup put `deleted_at IS NULL` beside an `OR` of phone matches, so D1 walked a `deleted_at` index over all 200,000 customers. The event drain read every due outbox row before taking a few (the 1,000,000-order store carries a backlog of about 700,000 seed events: 695,000 rows a drain, 1,000,000 for the settle). Each is now index-driven, with plan guards (`checkout-read-plans.d1.test.ts`, `events.d1.test.ts`). The heaviest remaining reads are the automatic-promotion reads (1,390 rows each; the seed has 400 automatic promotions). One client: 1.1 to 4.5 orders a second, bounded by the Miniflare proxy (above). On PostgreSQL the cart's SKU read (`product_id IN (...) OR id IN (...)`) was a sequential scan of every SKU; a checkout read 376,197 tuples and now 47,387, and one client went from 5.4 to 13.4 orders a second.
2. **The product page reads about 118,000 rows, the all-products listing 184,000 and a search 52,000 on D1** (category pages 8,000 to 10,000). The caches hide this for repeat visitors; a cache miss pays it.
3. **Fixed, with a limit: PostgreSQL checkout at 16 concurrent clients answered HTTP 500 for 45% (spread SKUs) and 75% (one hot SKU) of orders.** Two writers claiming the next stock version of one SKU collided as a unique violation (`23505`) the adapter could not retry: every ledger movement insert now reads its own `(variant, version)` key first, so PostgreSQL reports the race as a serialization failure (`40001`) and the adapter retries it on a fresh snapshot, where the stock-version check answers. The rest exhausted eight retries: checkouts still serialize on PostgreSQL (each takes the next order number with `max(order_number) + 1`, and SERIALIZABLE's page-level read locks make appends to the same index pages conflict), so the budget is now 32 attempts with the backoff capped at 50 ms, and a write that still loses is answered 503 `SERVICE_UNAVAILABLE` (retry-safe; checkout is idempotent by its request id), never 500. Now: 0 failed with 500; 4.3% (spread) and 3.8% (hot SKU) answered 503, at 16.7 and 22.3 orders a second; no oversell, no stock-version gaps, one order number per order. Beta update (2026-10-15): migration 0154 adds a native PostgreSQL order-number sequence, and a focused 16-writer insert test passes. The throughput figures above predate that change; rerun the full checkout scale proof before claiming a new capacity result.
4. **Fixed: the storefront homepage returned HTTP 500 on PostgreSQL** (`subquery in FROM must have an alias`: the card facts embedded a list's id query as an unaliased derived table). `homepage.postgres-native.test.ts` reads every homepage section kind on PostgreSQL.
5. **Fixed: the idle cron tick wrote 2 rows on the Free profile** (2,880 rows a day per store); it writes 0 (see Recorded budgets).
6. **Fixed: status/refund measurements included the next run's checkout preparation.** Snapshotting counters corrects the 71/80 report; both operations now enforce the per-invocation ceiling. Notification provider recovery also reads its settings timestamp and receipt history in one batch. Integrated measurements are 32 status-change calls and 41 refund calls on both profiles, with the strict 50-query ceiling enforced.
7. **The seed's order insert rate fell from about 700 to 185 a second as the table grew to 1,000,000 orders**: an insert does work that grows with the table (the plan of an `orders` insert scans `order_holds`).
