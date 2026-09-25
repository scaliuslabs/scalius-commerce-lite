import { createRuntimeApiApp } from "./base-app";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { privateNoStore } from "../middleware/private-no-store";
import { commitSeqMiddleware } from "../middleware/commit-seq";

export function createAdminRuntimeApiApp() {
  const app = createRuntimeApiApp();
  app.use("/admin/*", privateNoStore);
  app.use("/admin/*", dashboardOriginGuardMiddleware);
  app.use("/admin/*", adminAuthMiddleware);
  app.use("/admin/*", commitSeqMiddleware);
  return app;
}
