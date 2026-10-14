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
Not measured yet.
<!-- scale-proof:end -->

## Reading the results

Open findings the proof and the gates surfaced are listed here until they are fixed.

- `scripts/scale-proof.test.ts` product page reads grow with the catalogue on both engines; the metered rows read of one product page is the number to watch.
