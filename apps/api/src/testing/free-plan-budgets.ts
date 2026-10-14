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
 * order-lifecycle (2026-10-14, queue retirement): one 3-line order costs 34 D1
 * calls, the commit and its after-response work together; with the queue it
 * was 40 (13 for the commit, the rest in the queue consumer).
 */
import type { WorkersPlan } from "@scalius/shared/plan-limits";

export interface Budget {
  d1Calls?: number;
  d1Statements?: number;
  externalFetches?: number;
}

export const BUDGETS: Record<WorkersPlan, Record<string, Budget>> = {
  free: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, externalFetches: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0 },
    "customer-otp-request": { d1Calls: 16, d1Statements: 17, externalFetches: 0 },
    "customer-otp-verify": { d1Calls: 27, d1Statements: 39, externalFetches: 0 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, externalFetches: 0 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0 },
    "page-product-miss": { d1Calls: 21, d1Statements: 43, externalFetches: 0 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, externalFetches: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, externalFetches: 0 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, externalFetches: 0 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, externalFetches: 0 },
    "checkout-20-commit": { d1Calls: 38, d1Statements: 139, externalFetches: 0 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, externalFetches: 0 },
    "checkout-99-commit": { d1Calls: 34, d1Statements: 394, externalFetches: 0 },
    "admin-order-list": { d1Calls: 12, d1Statements: 366, externalFetches: 0 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0 },
    "admin-product-save": { d1Calls: 24, d1Statements: 39, externalFetches: 0 },
    "cron-idle": { d1Calls: 24, d1Statements: 27, externalFetches: 0 },
    "cron-busy": { d1Calls: 13, d1Statements: 13, externalFetches: 0 },
    "cron-nightly": { d1Calls: 22, d1Statements: 29, externalFetches: 0 },
    "drain-busy": { d1Calls: 14, d1Statements: 22, externalFetches: 0 },
    "order-3-line-commit": { d1Calls: 34, d1Statements: 80, externalFetches: 0 },
    "order-lifecycle": { d1Calls: 34, d1Statements: 80, externalFetches: 0 },
  },
  paid: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, externalFetches: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, externalFetches: 0 },
    "customer-otp-request": { d1Calls: 16, d1Statements: 17, externalFetches: 0 },
    "customer-otp-verify": { d1Calls: 27, d1Statements: 39, externalFetches: 0 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, externalFetches: 0 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0 },
    "page-product-miss": { d1Calls: 21, d1Statements: 43, externalFetches: 0 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, externalFetches: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, externalFetches: 0 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, externalFetches: 0 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, externalFetches: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, externalFetches: 0 },
    "checkout-20-commit": { d1Calls: 38, d1Statements: 139, externalFetches: 0 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, externalFetches: 0 },
    "checkout-99-commit": { d1Calls: 34, d1Statements: 394, externalFetches: 0 },
    "admin-order-list": { d1Calls: 12, d1Statements: 366, externalFetches: 0 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, externalFetches: 0 },
    "admin-product-save": { d1Calls: 38, d1Statements: 60, externalFetches: 0 },
    "cron-idle": { d1Calls: 62, d1Statements: 68, externalFetches: 0 },
    "cron-busy": { d1Calls: 777, d1Statements: 778, externalFetches: 0 },
    "cron-nightly": { d1Calls: 210, d1Statements: 311, externalFetches: 0 },
    "drain-busy": { d1Calls: 12, d1Statements: 25, externalFetches: 0 },
    "order-3-line-commit": { d1Calls: 34, d1Statements: 80, externalFetches: 0 },
    "order-lifecycle": { d1Calls: 34, d1Statements: 80, externalFetches: 0 },
  },
};
