import { createRuntimeApiApp } from "./base-app";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";

export function createAdminRuntimeApiApp() {
  const app = createRuntimeApiApp();
  app.use("/admin/*", dashboardOriginGuardMiddleware);
  app.use("/admin/*", adminAuthMiddleware);
  return app;
}
