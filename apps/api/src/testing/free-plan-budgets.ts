/**
 * The recorded budgets of the Workers plan harness (free-plan-budget.test.ts),
 * per plan profile and operation: the most D1 calls, D1 statements, queue
 * messages and external subrequests each may use. They are the measured
 * values of the seeded store, so a new query or a new sequential await fails
 * the test before it reaches production. Raising one is a decision: say why
 * in the commit message.
 *
 * Regenerate after a deliberate change with
 *   FREE_PLAN_BUDGET_RECORD=1 FREE_PLAN_BUDGET_REPORT=/tmp/report.json pnpm exec vitest run apps/api/src/free-plan-budget.test.ts
 * and `node scripts/free-plan-budget.mjs --budgets /tmp/report.json`.
 */
import type { WorkersPlan } from "@scalius/shared/plan-limits";

export interface Budget {
  d1Calls?: number;
  d1Statements?: number;
  queueMessages?: number;
  externalFetches?: number;
}

export const BUDGETS: Record<WorkersPlan, Record<string, Budget>> = {
  free: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, queueMessages: 0, externalFetches: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, queueMessages: 0, externalFetches: 0 },
    "customer-otp-request": { d1Calls: 6, d1Statements: 6, queueMessages: 1, externalFetches: 0 },
    "customer-otp-verify": { d1Calls: 17, d1Statements: 28, queueMessages: 1, externalFetches: 0 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, queueMessages: 0, externalFetches: 0 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, queueMessages: 0, externalFetches: 0 },
    "page-product-miss": { d1Calls: 21, d1Statements: 43, queueMessages: 0, externalFetches: 0 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, queueMessages: 0, externalFetches: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, queueMessages: 0, externalFetches: 0 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, queueMessages: 0, externalFetches: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, queueMessages: 0, externalFetches: 0 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, queueMessages: 0, externalFetches: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, queueMessages: 0, externalFetches: 0 },
    "checkout-20-commit": { d1Calls: 13, d1Statements: 109, queueMessages: 1, externalFetches: 0 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, queueMessages: 0, externalFetches: 0 },
    "checkout-99-commit": { d1Calls: 13, d1Statements: 368, queueMessages: 1, externalFetches: 0 },
    "admin-order-list": { d1Calls: 12, d1Statements: 366, queueMessages: 0, externalFetches: 0 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, queueMessages: 0, externalFetches: 0 },
    "admin-product-save": { d1Calls: 13, d1Statements: 23, queueMessages: 3, externalFetches: 0 },
    "cron-idle": { d1Calls: 22, d1Statements: 23, queueMessages: 5, externalFetches: 0 },
    "cron-busy": { d1Calls: 17, d1Statements: 18, queueMessages: 11, externalFetches: 0 },
    "cron-nightly": { d1Calls: 16, d1Statements: 18, queueMessages: 15, externalFetches: 0 },
    "queue-auth.send_otp": { d1Calls: 10, d1Statements: 11, queueMessages: 0, externalFetches: 0 },
    "queue-notification": { d1Calls: 31, d1Statements: 36, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.recommendations.refresh": { d1Calls: 11, d1Statements: 16, queueMessages: 0, externalFetches: 0 },
    "queue-maintenance.sweep": { d1Calls: 2, d1Statements: 2, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.projections.rebuild": { d1Calls: 3, d1Statements: 11, queueMessages: 1, externalFetches: 0 },
    "queue-media.render_variants": { d1Calls: 0, d1Statements: 0, queueMessages: 0, externalFetches: 0 },
    "order-3-line-commit": { d1Calls: 13, d1Statements: 54, queueMessages: 1, externalFetches: 0 },
    "order-lifecycle": { d1Calls: 40, d1Statements: 86, queueMessages: 1, externalFetches: 0 },
  },
  paid: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, queueMessages: 0, externalFetches: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, queueMessages: 0, externalFetches: 0 },
    "customer-otp-request": { d1Calls: 6, d1Statements: 6, queueMessages: 1, externalFetches: 0 },
    "customer-otp-verify": { d1Calls: 17, d1Statements: 28, queueMessages: 1, externalFetches: 0 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, queueMessages: 0, externalFetches: 0 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, queueMessages: 0, externalFetches: 0 },
    "page-product-miss": { d1Calls: 21, d1Statements: 43, queueMessages: 0, externalFetches: 0 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, queueMessages: 0, externalFetches: 0 },
    "page-category-miss": { d1Calls: 5, d1Statements: 17, queueMessages: 0, externalFetches: 0 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, queueMessages: 0, externalFetches: 0 },
    "page-search-miss": { d1Calls: 6, d1Statements: 15, queueMessages: 0, externalFetches: 0 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, queueMessages: 0, externalFetches: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, queueMessages: 0, externalFetches: 0 },
    "checkout-20-commit": { d1Calls: 13, d1Statements: 109, queueMessages: 1, externalFetches: 0 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, queueMessages: 0, externalFetches: 0 },
    "checkout-99-commit": { d1Calls: 13, d1Statements: 368, queueMessages: 1, externalFetches: 0 },
    "admin-order-list": { d1Calls: 12, d1Statements: 366, queueMessages: 0, externalFetches: 0 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, queueMessages: 0, externalFetches: 0 },
    "admin-product-save": { d1Calls: 13, d1Statements: 23, queueMessages: 1, externalFetches: 0 },
    "cron-idle": { d1Calls: 57, d1Statements: 63, queueMessages: 1, externalFetches: 0 },
    "cron-busy": { d1Calls: 39, d1Statements: 40, queueMessages: 1000, externalFetches: 0 },
    "cron-nightly": { d1Calls: 48, d1Statements: 52, queueMessages: 6, externalFetches: 0 },
    "queue-auth.send_otp": { d1Calls: 80, d1Statements: 88, queueMessages: 0, externalFetches: 0 },
    "queue-notification": { d1Calls: 166, d1Statements: 196, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.recommendations.refresh": { d1Calls: 510, d1Statements: 758, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.projections.rebuild": { d1Calls: 15, d1Statements: 54, queueMessages: 0, externalFetches: 0 },
    "queue-media.render_variants": { d1Calls: 0, d1Statements: 0, queueMessages: 0, externalFetches: 0 },
    "order-3-line-commit": { d1Calls: 13, d1Statements: 54, queueMessages: 1, externalFetches: 0 },
    "order-lifecycle": { d1Calls: 40, d1Statements: 86, queueMessages: 1, externalFetches: 0 },
  },
};
