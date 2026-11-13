import { adminAuthMiddleware } from "../middleware/admin-auth";
import { adminJsonBodyLimitMiddleware } from "../middleware/admin-json-body-limit";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { privateNoStore } from "../middleware/private-no-store";
import { commitSeqMiddleware } from "../middleware/commit-seq";
import { idempotentReplay } from "../routes/admin/idempotency";

/**
 * The dashboard API's middleware, which the mount table (route-table.ts)
 * puts on /admin/* for every admin group: no-store, the dashboard origin
 * guard, session or agent auth with RBAC, a bounded JSON body, the commit sequence, and the
 * replay of a stable create repeated with its Idempotency-Key.
 */
export const ADMIN_MIDDLEWARE = {
  privateNoStore,
  dashboardOriginGuard: dashboardOriginGuardMiddleware,
  adminAuth: adminAuthMiddleware,
  adminJsonBodyLimit: adminJsonBodyLimitMiddleware,
  commitSeq: commitSeqMiddleware,
  idempotentReplay,
};
