/**
 * The recorded budgets of the Workers plan harness (free-plan-budget.test.ts),
 * per plan profile and operation: the most D1 calls, D1 statements and
 * external subrequests each may use (after-response work included). They are the measured
 * values of the seeded store, so a new query or a new sequential await fails
 * the test before it reaches production. Raising one is a decision: say why
 * in the commit message.
 *
 * Regenerate after a deliberate change with `pnpm free-plan:budget --record`,
 * which prints this file's `BUDGETS` source.
 *
 * Rows written is the cost: D1 bills $1 a million (reads are $0.001), so a store's price is the rows
 * its operations write. `rowsWritten`/`rowsRead`/`fullScans` bound the worst run (the first run pays
 * one-off fills) with 5% + 1 row of headroom; `mean*` bounds a steady state. docs/SCALE.md explains the billed multiplier.
 *
 * order-lifecycle (2026-10-14, queue retirement): one 3-line order costs 34 D1
 * calls, the commit and its after-response work together; with the queue it
 * was 40 (13 for the commit, the rest in the queue consumer).
 *
 * Status/refund (2026-10-15): 32/41 calls with RBAC warm, 38/47 in isolation
 * with a cold marker. Both retain a 50-call cap; other counters cover both runs.
 * Earlier 71/80 counts included the next run's setup.
 * The first admin list now measures existing RBAC reconciliation against seeded
 * roles, matching real first-admin setup: 9 calls, 15 statements, 0 writes. Its
 * 1,255 estimated reads include permission/grant scans; warm lists read 53 rows.
 * Cron (2026-10-15): first bundled-app registration creates three Object types;
 * their capacity checks add three scans of the at-most-100-row type catalogue.
 * INSERT RETURNING avoids rereading each created type. Measured worst calls are
 * 23 Free / 62 Paid; steady-state writes remain zero on both profiles.
 * Bulk runs (2026-10-19): every tick's drain looks for a due bulk run (one
 * indexed read of bulk_runs, no rows on an idle store): +1 call per tick,
 * 24 Free / 63 Paid idle.
 * Server tracking (2026-10-19): the GA4/TikTok due rows and the hourly purges
 * ride in the Meta outbox's batch (no new call): +3 statements on the Paid
 * idle tick that runs it, 69 with bulk runs; Free is unchanged.
 * Trigger scans (2026-10-20): the meter now also plans the triggers a write
 * fires (free-plan-meter.ts). Every scan it found in a trigger body reads a
 * small configuration table, never one that grows with the catalogue or the
 * orders: navigation_menus (products/categories/collections/pages navigation
 * dependency triggers) and sales_channels (channel stock and publishing
 * triggers). A product save fires both: fullScans 27 -> 29 Free, 55 -> 57
 * Paid; the drain's rebuild chunk fires one: 10 -> 11 Free. Recorded as an
 * accepted cost, not a code change.
 * New cases (2026-10-20): a bulk run's 90-product chunk in coarse cache-clock
 * mode (7 calls, 1,944 rows: about 22 rows a product, so a 5,000-item run is
 * about 108k rows, still above Free's 100k daily writes); a 3-line checkout
 * with Meta, GA4 and TikTok on (45 calls of Free's 50); a hosted payment
 * confirmation with the three purchases (25 calls).
 * Due-work probe (2026-10-21): one statement asks every background drain's
 * index probes whether it has due rows (scheduled/due-work.ts) and only those
 * drains run. Idle tick mean 8.78 -> 2.78 calls Free, 9.73 -> 3.73 Paid; worst
 * idle minute 15 -> 10 Free, 51 -> 45 Paid; a busy drain tick 12 -> 7 Free,
 * 13 -> 8 Paid. The probe's one-row SELECT adds one row read a tick.
 *
 * FTS5 update guards (2026-10-21, migration 0169): a SKU's stock write no longer
 * deletes and re-inserts its unchanged search text, nor a product's revision
 * bump: rows written per 20-line checkout commit 559 -> 365, 99-line
 * 2,523 -> 1,503, 3-line order 93 -> 69, SKU stock change 48 -> 6, bulk run
 * chunk 1,944 -> 996. Budgets lowered to the new measurements.
 *
 * SKU stock change (2026-10-21): the stable write answering its SKU (L1) had
 * taken it to 13 calls and 18 statements (the Idempotency-Key lease adds no
 * call: its claim and completion are the two the key always cost). The
 * operation's reads (its key's earlier result, the SKU, the location with the
 * SKU's on-hand there) are one batch, and the SKU's read-back rides at the end
 * of the commit batch: 9 calls, 17 statements. Run alone, the case pays 6 more
 * for the cold RBAC reconciliation marker (15).
 */
import type { WorkersPlan } from "@scalius/shared/plan-limits";

export interface Budget {
  d1Calls?: number;
  d1Statements?: number;
  externalFetches?: number;
  /**
   * Rows written, the cost D1 bills ($1 a million; reads are $0.001): SQLite's rows changed, triggers'
   * writes included. D1 also bills the index entries of each row (docs/SCALE.md has the measured multiplier).
   */
  rowsWritten?: number;
  /** Rows read (plan estimate: rows returned plus every scanned table's rows). */
  rowsRead?: number;
  /** Full table scans in the executed plans: a scan reads more rows with every row the table gains. */
  fullScans?: number;
  /** A steady state's mean rows written per run (the idle cron tick is paid a thousand times a day, by every store). */
  meanRowsWritten?: number;
  meanRowsRead?: number;
}

export const BUDGETS: Record<WorkersPlan, Record<string, Budget>> = {
  free: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, externalFetches: 0, rowsWritten: 4, rowsRead: 8, fullScans: 0 },
    // rowsRead grows with the bundled apps a deployment ships (Noor and the
    // Bangladesh pack today).
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0, rowsWritten: 5, rowsRead: 8, fullScans: 17 },
    "customer-otp-request": { d1Calls: 16, d1Statements: 17, externalFetches: 0, rowsWritten: 9, rowsRead: 20, fullScans: 2 },
    "customer-otp-verify": { d1Calls: 27, d1Statements: 39, externalFetches: 0, rowsWritten: 18, rowsRead: 30, fullScans: 5 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, externalFetches: 0, rowsWritten: 1, rowsRead: 130, fullScans: 16 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-product-miss": { d1Calls: 21, d1Statements: 43, externalFetches: 0, rowsWritten: 1, rowsRead: 137, fullScans: 15 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, externalFetches: 0, rowsWritten: 1, rowsRead: 4, fullScans: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, externalFetches: 0, rowsWritten: 1, rowsRead: 117, fullScans: 6 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 764, fullScans: 17 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, externalFetches: 0, rowsWritten: 1, rowsRead: 51, fullScans: 4 },
    "checkout-20-commit": { d1Calls: 38, d1Statements: 139, externalFetches: 0, rowsWritten: 385, rowsRead: 217, fullScans: 56 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, externalFetches: 0, rowsWritten: 1, rowsRead: 217, fullScans: 4 },
    "checkout-99-commit": { d1Calls: 34, d1Statements: 394, externalFetches: 0, rowsWritten: 1663, rowsRead: 887, fullScans: 205 },
    "admin-order-list": { d1Calls: 9, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 1319, fullScans: 4 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0, rowsWritten: 1, rowsRead: 57, fullScans: 0 },
    "admin-product-save": { d1Calls: 24, d1Statements: 39, externalFetches: 0, rowsWritten: 549, rowsRead: 161, fullScans: 29 },
    "order-status-change": { d1Calls: 50, d1Statements: 42, externalFetches: 0, rowsWritten: 35, rowsRead: 1286, fullScans: 5 },
    "order-refund": { d1Calls: 50, d1Statements: 53, externalFetches: 0, rowsWritten: 73, rowsRead: 1292, fullScans: 6 },
    "sku-stock-change": { d1Calls: 9, d1Statements: 17, externalFetches: 0, rowsWritten: 8, rowsRead: 21, fullScans: 7 },
    "cron-idle": { d1Calls: 19, d1Statements: 20, externalFetches: 0, rowsWritten: 117, rowsRead: 7556, fullScans: 21, meanRowsWritten: 0, meanRowsRead: 15.79 },
    "cron-nightly": { d1Calls: 25, d1Statements: 32, externalFetches: 0, rowsWritten: 432, rowsRead: 25963, fullScans: 91 },
    "drain-busy": { d1Calls: 7, d1Statements: 17, externalFetches: 0, rowsWritten: 103, rowsRead: 882, fullScans: 21 },
    "order-3-line-commit": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 74, rowsRead: 73, fullScans: 26 },
    "order-lifecycle": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 74, rowsRead: 73, fullScans: 26 },
    "bulk-run-chunk": { d1Calls: 7, d1Statements: 195, externalFetches: 0, rowsWritten: 1142, rowsRead: 295, fullScans: 7 },
    "order-3-line-commit-tracking": { d1Calls: 45, d1Statements: 108, externalFetches: 3, rowsWritten: 153, rowsRead: 102, fullScans: 28 },
    "payment-webhook-confirmed": { d1Calls: 25, d1Statements: 37, externalFetches: 1, rowsWritten: 14, rowsRead: 31, fullScans: 1 },
  },
  paid: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, externalFetches: 0, rowsWritten: 4, rowsRead: 8, fullScans: 0 },
    // rowsRead grows with the bundled apps a deployment ships (Noor and the
    // Bangladesh pack today).
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0, rowsWritten: 5, rowsRead: 8, fullScans: 17 },
    "customer-otp-request": { d1Calls: 16, d1Statements: 17, externalFetches: 0, rowsWritten: 9, rowsRead: 20, fullScans: 2 },
    "customer-otp-verify": { d1Calls: 27, d1Statements: 39, externalFetches: 0, rowsWritten: 18, rowsRead: 30, fullScans: 5 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, externalFetches: 0, rowsWritten: 1, rowsRead: 130, fullScans: 16 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-product-miss": { d1Calls: 21, d1Statements: 43, externalFetches: 0, rowsWritten: 1, rowsRead: 137, fullScans: 15 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, externalFetches: 0, rowsWritten: 1, rowsRead: 4, fullScans: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, externalFetches: 0, rowsWritten: 1, rowsRead: 117, fullScans: 6 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 764, fullScans: 17 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0, rowsWritten: 1, rowsRead: 3, fullScans: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, externalFetches: 0, rowsWritten: 1, rowsRead: 51, fullScans: 4 },
    "checkout-20-commit": { d1Calls: 38, d1Statements: 139, externalFetches: 0, rowsWritten: 385, rowsRead: 217, fullScans: 56 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, externalFetches: 0, rowsWritten: 1, rowsRead: 217, fullScans: 4 },
    "checkout-99-commit": { d1Calls: 34, d1Statements: 394, externalFetches: 0, rowsWritten: 1663, rowsRead: 887, fullScans: 205 },
    "admin-order-list": { d1Calls: 9, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 1319, fullScans: 4 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0, rowsWritten: 1, rowsRead: 57, fullScans: 0 },
    "admin-product-save": { d1Calls: 38, d1Statements: 60, externalFetches: 0, rowsWritten: 1254, rowsRead: 345, fullScans: 57 },
    "order-status-change": { d1Calls: 50, d1Statements: 42, externalFetches: 0, rowsWritten: 35, rowsRead: 1286, fullScans: 5 },
    "order-refund": { d1Calls: 50, d1Statements: 53, externalFetches: 0, rowsWritten: 73, rowsRead: 1292, fullScans: 6 },
    "sku-stock-change": { d1Calls: 9, d1Statements: 17, externalFetches: 0, rowsWritten: 8, rowsRead: 21, fullScans: 7 },
    "cron-idle": { d1Calls: 57, d1Statements: 63, externalFetches: 0, rowsWritten: 175, rowsRead: 7992, fullScans: 27, meanRowsWritten: 0, meanRowsRead: 30.1 },
    "cron-nightly": { d1Calls: 213, d1Statements: 314, externalFetches: 0, rowsWritten: 432, rowsRead: 28529, fullScans: 467 },
    "drain-busy": { d1Calls: 8, d1Statements: 23, externalFetches: 0, rowsWritten: 118, rowsRead: 890, fullScans: 27 },
    "order-3-line-commit": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 74, rowsRead: 73, fullScans: 26 },
    "order-lifecycle": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 74, rowsRead: 73, fullScans: 26 },
    "bulk-run-chunk": { d1Calls: 7, d1Statements: 195, externalFetches: 0, rowsWritten: 1142, rowsRead: 295, fullScans: 7 },
    "order-3-line-commit-tracking": { d1Calls: 45, d1Statements: 108, externalFetches: 3, rowsWritten: 153, rowsRead: 102, fullScans: 28 },
    "payment-webhook-confirmed": { d1Calls: 25, d1Statements: 37, externalFetches: 1, rowsWritten: 14, rowsRead: 31, fullScans: 1 },
  },
};
