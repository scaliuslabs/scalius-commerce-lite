import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminAnalyticsRoutes } from "../routes/admin/analytics";
import { adminDashboardRoutes } from "../routes/admin/dashboard";
import { adminReportRoutes } from "../routes/admin/reports";
import { adminFraudCheckerRoutes } from "../routes/admin/fraud-checker";
import { adminSearchRoutes } from "../routes/admin/search";
import { adminSystemUtilsRoutes } from "../routes/admin/system-utils";
import { adminWebPushRoutes } from "../routes/admin/web-push";

const app = createAdminRuntimeApiApp();
app.route("/admin/analytics", adminAnalyticsRoutes);
app.route("/admin/dashboard", adminDashboardRoutes);
app.route("/admin/reports", adminReportRoutes);
app.route("/admin/fraud-checker", adminFraudCheckerRoutes);
app.route("/admin/search", adminSearchRoutes);
app.route("/admin/web-push", adminWebPushRoutes);
app.route("/admin", adminSystemUtilsRoutes);

export default app;
