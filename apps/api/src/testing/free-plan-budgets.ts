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
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0, rowsWritten: 5, rowsRead: 6, fullScans: 17 },
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
    "checkout-20-commit": { d1Calls: 38, d1Statements: 139, externalFetches: 0, rowsWritten: 593, rowsRead: 217, fullScans: 56 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, externalFetches: 0, rowsWritten: 1, rowsRead: 217, fullScans: 4 },
    "checkout-99-commit": { d1Calls: 34, d1Statements: 394, externalFetches: 0, rowsWritten: 2676, rowsRead: 887, fullScans: 205 },
    "admin-order-list": { d1Calls: 9, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 1319, fullScans: 4 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0, rowsWritten: 1, rowsRead: 57, fullScans: 0 },
    "admin-product-save": { d1Calls: 24, d1Statements: 39, externalFetches: 0, rowsWritten: 549, rowsRead: 161, fullScans: 27 },
    "order-status-change": { d1Calls: 50, d1Statements: 42, externalFetches: 0, rowsWritten: 35, rowsRead: 1286, fullScans: 5 },
    "order-refund": { d1Calls: 50, d1Statements: 53, externalFetches: 0, rowsWritten: 73, rowsRead: 1292, fullScans: 6 },
    "sku-stock-change": { d1Calls: 13, d1Statements: 17, externalFetches: 0, rowsWritten: 53, rowsRead: 21, fullScans: 7 },
    "cron-idle": { d1Calls: 23, d1Statements: 23, externalFetches: 0, rowsWritten: 110, rowsRead: 7548, fullScans: 11, meanRowsWritten: 0, meanRowsRead: 14.63 },
    "cron-nightly": { d1Calls: 22, d1Statements: 29, externalFetches: 0, rowsWritten: 432, rowsRead: 24972, fullScans: 54 },
    "drain-busy": { d1Calls: 11, d1Statements: 18, externalFetches: 0, rowsWritten: 103, rowsRead: 218, fullScans: 10 },
    "order-3-line-commit": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 106, rowsRead: 73, fullScans: 26 },
    "order-lifecycle": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 106, rowsRead: 73, fullScans: 26 },
  },
  paid: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, externalFetches: 0, rowsWritten: 4, rowsRead: 8, fullScans: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0, rowsWritten: 5, rowsRead: 6, fullScans: 17 },
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
    "checkout-20-commit": { d1Calls: 38, d1Statements: 139, externalFetches: 0, rowsWritten: 593, rowsRead: 217, fullScans: 56 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, externalFetches: 0, rowsWritten: 1, rowsRead: 217, fullScans: 4 },
    "checkout-99-commit": { d1Calls: 34, d1Statements: 394, externalFetches: 0, rowsWritten: 2676, rowsRead: 887, fullScans: 205 },
    "admin-order-list": { d1Calls: 9, d1Statements: 15, externalFetches: 0, rowsWritten: 1, rowsRead: 1319, fullScans: 4 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0, rowsWritten: 1, rowsRead: 57, fullScans: 0 },
    "admin-product-save": { d1Calls: 38, d1Statements: 60, externalFetches: 0, rowsWritten: 1254, rowsRead: 345, fullScans: 55 },
    "order-status-change": { d1Calls: 50, d1Statements: 42, externalFetches: 0, rowsWritten: 35, rowsRead: 1286, fullScans: 5 },
    "order-refund": { d1Calls: 50, d1Statements: 53, externalFetches: 0, rowsWritten: 73, rowsRead: 1292, fullScans: 6 },
    "sku-stock-change": { d1Calls: 13, d1Statements: 17, externalFetches: 0, rowsWritten: 53, rowsRead: 21, fullScans: 7 },
    "cron-idle": { d1Calls: 62, d1Statements: 68, externalFetches: 0, rowsWritten: 175, rowsRead: 7976, fullScans: 21, meanRowsWritten: 0, meanRowsRead: 28.77 },
    "cron-nightly": { d1Calls: 210, d1Statements: 311, externalFetches: 0, rowsWritten: 432, rowsRead: 27538, fullScans: 430 },
    "drain-busy": { d1Calls: 12, d1Statements: 24, externalFetches: 0, rowsWritten: 118, rowsRead: 236, fullScans: 17 },
    "order-3-line-commit": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 106, rowsRead: 73, fullScans: 26 },
    "order-lifecycle": { d1Calls: 34, d1Statements: 80, externalFetches: 0, rowsWritten: 106, rowsRead: 73, fullScans: 26 },
  },
};
