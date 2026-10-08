/**
 * The recorded budgets of the Workers plan harness (free-plan-budget.test.ts),
 * per plan profile and operation: the most D1 calls, D1 statements, KV reads,
 * KV writes and deletes, queue messages and external subrequests each may use.
 * They are the measured values of the seeded store, so a new query, a new
 * sequential await or a new KV write fails the test before it reaches
 * production. Raising one is a decision: say why in the commit message.
 *
 * Regenerate after a deliberate change with
 *   FREE_PLAN_BUDGET_RECORD=1 FREE_PLAN_BUDGET_REPORT=/tmp/report.json pnpm exec vitest run apps/api/src/free-plan-budget.test.ts
 * and `node scripts/free-plan-budget.mjs --budgets /tmp/report.json`.
 */
import type { WorkersPlan } from "@scalius/shared/plan-limits";

export interface Budget {
  d1Calls?: number;
  d1Statements?: number;
  kvReads?: number;
  kvWrites?: number;
  kvDeletes?: number;
  queueMessages?: number;
  externalFetches?: number;
}

export const BUDGETS: Record<WorkersPlan, Record<string, Budget>> = {
  free: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, kvReads: 0, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "customer-otp-request": { d1Calls: 6, d1Statements: 6, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "customer-otp-verify": { d1Calls: 16, d1Statements: 27, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-product-miss": { d1Calls: 22, d1Statements: 44, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-category-miss": { d1Calls: 6, d1Statements: 18, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-search-miss": { d1Calls: 7, d1Statements: 16, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "checkout-20-commit": { d1Calls: 13, d1Statements: 109, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "checkout-99-commit": { d1Calls: 13, d1Statements: 368, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "admin-order-list": { d1Calls: 12, d1Statements: 363, kvReads: 2, kvWrites: 1, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "admin-product-save": { d1Calls: 13, d1Statements: 23, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 3, externalFetches: 0 },
    "cron-idle": { d1Calls: 38, d1Statements: 45, kvReads: 2, kvWrites: 1, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "cron-busy": { d1Calls: 18, d1Statements: 18, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 10, externalFetches: 0 },
    "cron-nightly": { d1Calls: 15, d1Statements: 18, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 11, externalFetches: 0 },
    "queue-auth.send_otp": { d1Calls: 10, d1Statements: 11, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-notification": { d1Calls: 28, d1Statements: 29, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.recommendations.refresh": { d1Calls: 11, d1Statements: 16, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.projections.rebuild": { d1Calls: 2, d1Statements: 7, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "queue-media.render_variants": { d1Calls: 0, d1Statements: 0, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "order-3-line-commit": { d1Calls: 13, d1Statements: 54, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "order-lifecycle": { d1Calls: 37, d1Statements: 79, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
  },
  paid: {
    "staff-sign-in": { d1Calls: 6, d1Statements: 6, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "staff-sign-up": { d1Calls: 5, d1Statements: 5, kvReads: 0, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "customer-otp-request": { d1Calls: 6, d1Statements: 6, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "customer-otp-verify": { d1Calls: 16, d1Statements: 27, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "page-home-miss": { d1Calls: 12, d1Statements: 26, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-home-hit": { d1Calls: 1, d1Statements: 1, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-product-miss": { d1Calls: 22, d1Statements: 44, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-product-hit": { d1Calls: 2, d1Statements: 6, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-category-miss": { d1Calls: 6, d1Statements: 18, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-category-hit": { d1Calls: 1, d1Statements: 1, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-search-miss": { d1Calls: 7, d1Statements: 16, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "page-search-hit": { d1Calls: 1, d1Statements: 1, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "checkout-20-quote": { d1Calls: 10, d1Statements: 18, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "checkout-20-commit": { d1Calls: 13, d1Statements: 109, kvReads: 1, kvWrites: 2, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "checkout-99-quote": { d1Calls: 11, d1Statements: 19, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "checkout-99-commit": { d1Calls: 13, d1Statements: 368, kvReads: 1, kvWrites: 2, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "admin-order-list": { d1Calls: 12, d1Statements: 363, kvReads: 2, kvWrites: 1, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "admin-order-list-deep": { d1Calls: 3, d1Statements: 7, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "admin-product-save": { d1Calls: 13, d1Statements: 23, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "cron-idle": { d1Calls: 62, d1Statements: 69, kvReads: 2, kvWrites: 1, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "cron-busy": { d1Calls: 36, d1Statements: 36, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 1000, externalFetches: 0 },
    "cron-nightly": { d1Calls: 39, d1Statements: 42, kvReads: 2, kvWrites: 0, kvDeletes: 0, queueMessages: 6, externalFetches: 0 },
    "queue-auth.send_otp": { d1Calls: 80, d1Statements: 88, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-notification": { d1Calls: 148, d1Statements: 154, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.recommendations.refresh": { d1Calls: 510, d1Statements: 758, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-catalog.projections.rebuild": { d1Calls: 12, d1Statements: 42, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "queue-media.render_variants": { d1Calls: 0, d1Statements: 0, kvReads: 1, kvWrites: 0, kvDeletes: 0, queueMessages: 0, externalFetches: 0 },
    "order-3-line-commit": { d1Calls: 13, d1Statements: 54, kvReads: 1, kvWrites: 2, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
    "order-lifecycle": { d1Calls: 37, d1Statements: 79, kvReads: 2, kvWrites: 2, kvDeletes: 0, queueMessages: 1, externalFetches: 0 },
  },
};
