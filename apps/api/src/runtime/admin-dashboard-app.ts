import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminAnalyticsRoutes } from "../routes/admin/analytics";
import { adminDashboardRoutes } from "../routes/admin/dashboard";
import { adminFraudCheckerRoutes } from "../routes/admin/fraud-checker";
import { adminSearchRoutes } from "../routes/admin/search";
import { adminSystemUtilsRoutes } from "../routes/admin/system-utils";

const app = createAdminRuntimeApiApp();
app.route("/admin/analytics", adminAnalyticsRoutes);
app.route("/admin/dashboard", adminDashboardRoutes);
app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
app.route("/admin/search", adminSearchRoutes);
app.route("/admin", adminSystemUtilsRoutes);

export default app;
