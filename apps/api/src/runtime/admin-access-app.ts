import { ADMIN_MIDDLEWARE } from "./admin-base-app";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { adminAgentAccessRoutes } from "../routes/admin/agent-access";
import { adminAuthManagementRoutes } from "../routes/admin/auth-management";
import { adminRbacRoutes } from "../routes/admin/rbac";
import { adminWebhookRoutes } from "../routes/admin/webhooks";
import { adminEventRoutes } from "../routes/admin/events";
import { adminAppRoutes } from "../routes/admin/apps";

export const adminAccessParts: RouteGroupParts<"admin-access"> = {
  routers: {
    adminRbacRoutes,
    adminAuthManagementRoutes,
    adminAgentAccessRoutes,
    adminWebhookRoutes,
    adminEventRoutes,
    adminAppRoutes,
  },
  middleware: ADMIN_MIDDLEWARE,
};

export default buildRouteGroupApp("admin-access", adminAccessParts);
