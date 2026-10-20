import { ADMIN_MIDDLEWARE } from "./admin-base-app";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { adminAnalyticsRoutes } from "../routes/admin/analytics";
import { adminDashboardRoutes } from "../routes/admin/dashboard";
import { adminReportRoutes } from "../routes/admin/reports";
import { adminFraudCheckerRoutes } from "../routes/admin/fraud-checker";
import { adminSearchRoutes } from "../routes/admin/search";
import { adminSystemUtilsRoutes } from "../routes/admin/system-utils";
import { adminWebPushRoutes } from "../routes/admin/web-push";
import { adminStaffAlertRoutes } from "../routes/admin/staff-alerts";

export const adminDashboardParts: RouteGroupParts<"admin-dashboard"> = {
  routers: {
    adminSearchRoutes,
    adminAnalyticsRoutes,
    adminDashboardRoutes,
    adminReportRoutes,
    adminFraudCheckerRoutes,
    adminWebPushRoutes,
    adminStaffAlertRoutes,
    adminSystemUtilsRoutes,
  },
  middleware: ADMIN_MIDDLEWARE,
};

export default buildRouteGroupApp("admin-dashboard", adminDashboardParts);
