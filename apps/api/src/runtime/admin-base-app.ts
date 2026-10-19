import { createRuntimeApiApp } from "./base-app";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { privateNoStore } from "../middleware/private-no-store";
import { commitSeqMiddleware } from "../middleware/commit-seq";
import { idempotentReplay } from "../routes/admin/idempotency";

export function createAdminRuntimeApiApp() {
  const app = createRuntimeApiApp();
  app.use("/admin/*", privateNoStore);
  app.use("/admin/*", dashboardOriginGuardMiddleware);
  app.use("/admin/*", adminAuthMiddleware);
  app.use("/admin/*", commitSeqMiddleware);
  // A stable create repeated with its Idempotency-Key returns the first response.
  app.use("/admin/*", idempotentReplay);
  return app;
}
