import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { privateNoStore } from "../middleware/private-no-store";
import { commitSeqMiddleware } from "../middleware/commit-seq";
import { idempotentReplay } from "../routes/admin/idempotency";

/**
 * The dashboard API's middleware, which the mount table (route-table.ts)
 * puts on /admin/* for every admin group: no-store, the dashboard origin
 * guard, session or agent auth with RBAC, the commit sequence, and the
 * replay of a stable create repeated with its Idempotency-Key.
 */
export const ADMIN_MIDDLEWARE = {
  privateNoStore,
  dashboardOriginGuard: dashboardOriginGuardMiddleware,
  adminAuth: adminAuthMiddleware,
  commitSeq: commitSeqMiddleware,
  idempotentReplay,
};
