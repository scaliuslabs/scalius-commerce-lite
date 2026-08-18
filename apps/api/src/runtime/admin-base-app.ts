import { createRuntimeApiApp } from "./base-app";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { cookieOriginGuardMiddleware } from "../middleware/cookie-origin-guard";

export function createAdminRuntimeApiApp() {
  const app = createRuntimeApiApp();
  app.use("/admin/*", cookieOriginGuardMiddleware);
  app.use("/admin/*", adminAuthMiddleware);
  return app;
}
