# Scale and cost

Last reviewed: 2026-10-14

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
| Order status change (pending to confirmed) | 71 | 80 | 99 | 94 | 27 |
| Order refund (cash, partly) | 80 | 51 | 64 | 100 | 28 |
| Product edit (admin save) | 24 | 35 | 522 | 154 | 27 |
| SKU stock change (+1 received) | 13 | 27 | 50 | 21 | 7 |
| Customer sign-up (code verify, new buyer) | 27 | 16 | 17 | 29 | 5 |
| Product page, cache miss | 21 | 0 | 0 | 129 | 15 |
| Category listing, cache miss | 5 | 0 | 0 | 110 | 6 |
| Search, cache miss | 6 | 0 | 0 | 828 | 17 |
| Product page, cache hit | 2 | 0 | 0 | 2 | 0 |
| Cron tick, idle store | 24 | 2 | 105 | 7,191 | 10 |

Read the cron row with care. A Free store ticks 1,440 times a day, so two rows a tick is 2,880 rows written a day per store before any order: a platform with 100,000 stores pays for 288 million rows a day, about $288, on idle alone (index entries extra). The Paid profile's idle mean is 0.

The 3-line order writes 100 table rows; D1 bills the scale proof's measured figure below, which includes index entries.

The status change and the refund run 71 and 80 D1 queries in their first (cold) invocation, over Free's 50 per invocation. The budget holds them from growing; shrinking them is open work.

## The scale proof

`node scripts/scale-proof.mjs --state <dir>` measures a store of 1,000,000 orders and about 150,000 SKUs (`scripts/catalog-scale-seed.mjs --profile huge`) on D1 (the local SQLite engine of workerd, through Miniflare) and on a temporary native PostgreSQL cluster loaded from the same data. It runs locally, takes about 20 minutes once the store exists (`--seed` builds it: about 30 minutes and 6 GB), never runs in CI, and removes its clone, its cluster and every process it started.

It measures:

- **Reads:** p50 and p95 over 20 timed runs of the main storefront reads, and the rows read by one metered run (D1 `meta.rows_read`; PostgreSQL tuples fetched).
- **Checkout throughput:** tax quote, commit and after-response work, at 1 and at 16 concurrent clients, with 3-line orders spread over many SKUs and with every order on one hot SKU. PostgreSQL serialization retries are counted; an order that fails is counted, never hidden.
- **Rows per order:** the rows one 3-line checkout reads and writes. On D1 this is D1's own accounting with index entries; on PostgreSQL it is the server's heap tuple counters.

Notes on the method. The API runs in-process (`fetchRuntimeApiApp`), so network and the Worker runtime are not in the figures; PostgreSQL goes through a connection pool that stands in for Hyperdrive, and both engines run on one machine with the clients. Compare engines and runs on the same machine, not against production latency.

<!-- scale-proof:start -->
### 1,000,000 orders, 156,244 SKUs

Measured 2026-10-14 at commit `a38969b7d` on Apple M1, 8 cores, 16 GB RAM, darwin 25.5.0, Node v24.21.0.
Engines: D1 (Miniflare, workerd SQLite).

Store: 1,000,000 orders, 1,928,791 order lines, 50,000 products, 156,244 SKUs, 200,000 customers.

Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):

| Read | d1 p50 | d1 p95 | d1 rows read |
| --- | ---: | ---: | ---: |
| home page (storefront homepage) | 34 | 38 | 907 |
| product page | 84 | 95 | 118,252 |
| category listing, page 1 | 41 | 47 | 10,209 |
| category listing, page 40 | 27 | 32 | 8,434 |
| all products, newest, page 1 | 71 | 88 | 183,734 |
| search | 65 | 66 | 52,133 |
| product feed page | 88 | 136 | 12,654 |

Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:

| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d1 | 3 lines over many SKUs | 1 | 150 | 1.1 | 746 | 1,694 | 0 | n/a |
| d1 | 1 hot SKU | 1 | 150 | 1.2 | 710 | 1,436 | 0 | n/a |

Rows one 3-line checkout reads and writes (quote, commit, after-response work):

| Engine | Rows read | Rows written | Counted as |
| --- | ---: | ---: | --- |
| d1 | 559,849 | 229 | D1 `rows_read`/`rows_written`, index entries included (what D1 bills) |

### 250,000 orders, 156,244 SKUs

Measured 2026-10-14 at commit `a227e141f` on Apple M1, 8 cores, 16 GB RAM, darwin 25.5.0, Node v24.21.0, 1-minute load average 4.4 at the end of the run (D1); PostgreSQL measured at fde9155bd, 1-minute load average 6.1 at the end of the run.
Engines: D1 (Miniflare, workerd SQLite); PostgreSQL 15.17 (Homebrew).

Store: 250,000 orders, 482,682 order lines, 50,000 products, 156,244 SKUs, 200,000 customers.

Storefront reads, in-process API, warm modules, 20 timed runs each (milliseconds):

| Read | d1 p50 | d1 p95 | d1 rows read | postgres p50 | postgres p95 | postgres rows read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| home page (storefront homepage) | 49 | 61 | 902 | 19 (HTTP 500) | 20 | 165 |
| product page | 127 | 164 | 115,877 | 211 | 227 | 118,660 |
| category listing, page 1 | 52 | 68 | 10,205 | 38 | 39 | 3,437 |
| category listing, page 40 | 36 | 56 | 8,436 | 28 | 37 | 2,119 |
| all products, newest, page 1 | 88 | 104 | 183,727 | 115 | 124 | 161,832 |
| search | 78 | 96 | 52,129 | 386 | 415 | 244,139 |
| product feed page | 107 | 167 | 12,654 | 4,943 | 5,011 | 1,347,991 |

Checkout (tax quote, commit and after-response work), orders per second of the orders that succeeded:

| Engine | Scenario | Clients | Orders | Orders/s | p50 ms | p95 ms | Failed | Serialization retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| d1 | 3 lines over many SKUs | 1 | 100 | 0.2 | 5,528 | 11,053 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 3 lines over many SKUs | 16 | 400 | 0.7 | 17,285 | 67,123 | 0 | 0 (168 Miniflare resets retried) |
| d1 | 1 hot SKU | 1 | 100 | 0.5 | 768 | 7,157 | 0 | 0 (0 Miniflare resets retried) |
| d1 | 1 hot SKU | 16 | 400 | 0.5 | 20,518 | 93,335 | 0 | 0 (292 Miniflare resets retried) |
| postgres | 3 lines over many SKUs | 1 | 100 | 5.4 | 178 | 202 | 0 | 0 |
| postgres | 3 lines over many SKUs | 16 | 218 | 8.0 | 601 | 1,448 | 182 (HTTP 500) | 1785 |
| postgres | 1 hot SKU | 1 | 100 | 6.0 | 166 | 185 | 0 | 0 |
| postgres | 1 hot SKU | 16 | 98 | 6.1 | 658 | 923 | 302 (HTTP 500) | 154 |

Rows one 3-line checkout reads and writes (quote, commit, after-response work):

| Engine | Rows read | Rows written | Counted as |
| --- | ---: | ---: | --- |
| d1 | 559,866 | 229 | D1 `rows_read`/`rows_written`, index entries included (what D1 bills) |
| postgres | 376,197 | 54 | heap tuples read, inserted, updated, deleted; index entries not counted |
<!-- scale-proof:end -->

## Reading the results

How far to trust the numbers:

- **Rows read and written are exact and repeatable.** The same 3-line checkout reads 559,866 rows on the 250,000-order store and 559,849 on the 1,000,000-order store: its reads follow the customers (200,000) and SKUs (156,244), not the orders.
- **Orders per second and latency are indicative.** The runs share a 16 GB laptop with the clients and with other jobs (the load average is in each block). The same D1 checkout ran at 1.1 orders per second on a quiet machine and at 0.2 on a loaded one. Compare engines within one block, and compare blocks by rows, not by seconds.
- **D1 here is Miniflare.** Its binding reaches workerd over HTTP, and a kept-alive connection the server has closed fails the next call with `ECONNRESET`; the harness retries it and counts it in the table. Real D1 does not do this. D1 serializes writes, so 16 clients wait on one writer, and an order on a hot SKU also retries on the stock version check.
- **PostgreSQL here is a local server** with a connection pool standing in for Hyperdrive, analyzed after the load (a bulk load leaves no planner statistics; a running store has autovacuum's). The 1,000,000-order copy needs more disk than the proof's host had, so PostgreSQL ran on the 250,000-order store, beside D1 on the same store.

## Open findings

The proof and the gates found these. They are open until fixed; the gates hold each from getting worse.

1. **A checkout reads 559,866 rows on D1 (about 2.4 times the cost of the 229 rows it writes at $1 against $0.001 a million).** Three statements are scans: the variant availability read (`product_variants` joined to `products` on `id IN (SELECT ... FROM json_each(?))`, 240,925 rows), the customer lookup by phone (an `OR` of two `phone = ?` predicates with different extra conditions, 200,384 rows: a full scan of `customers`), and the product pricing read (47,047 rows, twice). These are why one writer cannot do more than about one checkout a second at this size. The budget gate counts 26 full scans for a 3-line order in the small seed.
2. **The product page reads about 118,000 rows, the all-products listing 184,000 and a search 52,000 on D1** (category pages 8,000 to 10,000). The caches hide this for repeat visitors; a cache miss pays it.
3. **PostgreSQL checkout is not safe at 16 concurrent clients.** Of the orders sent, 45% (spread over SKUs) and 75% (one hot SKU) failed with HTTP 500, after about 1,800 and 150 serialization retries. The retry loop retries only `40001` and `40P01`; a concurrent insert of the next `inventory_movements` version for the same SKU raises `23505` on `inventory_movements_variant_version_uidx` and is not retried, and the rest exhaust the eight attempts. D1 and Turso do the same work with a compare-and-set.
4. **The storefront homepage returns HTTP 500 on PostgreSQL** (`subquery in FROM must have an alias`).
5. **The idle cron tick writes 2 rows on the Free profile** (2,880 rows a day per store). Paid writes none.
6. **An order status change and a refund run 71 and 80 D1 queries in their first invocation**, over Free's 50. The new `order-status-change` and `order-refund` budgets are exempt from the per-invocation ceiling so the gate can hold them at today's count.
7. **The seed's order insert rate fell from about 700 to 185 a second as the table grew to 1,000,000 orders**: an insert does work that grows with the table (the plan of an `orders` insert scans `order_holds`).
