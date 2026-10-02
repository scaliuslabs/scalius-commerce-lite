import { createAdminRuntimeApiApp } from "./admin-base-app";
import { adminAgentAccessRoutes } from "../routes/admin/agent-access";
import { adminAuthManagementRoutes } from "../routes/admin/auth-management";
import { adminRbacRoutes } from "../routes/admin/rbac";
import { adminWebhookRoutes } from "../routes/admin/webhooks";
import { adminEventRoutes } from "../routes/admin/events";

const app = createAdminRuntimeApiApp();
app.route("/admin/rbac", adminRbacRoutes);
app.route("/admin/auth", adminAuthManagementRoutes);
app.route("/admin/agent-access", adminAgentAccessRoutes);
app.route("/admin/webhooks", adminWebhookRoutes);
app.route("/admin/events", adminEventRoutes);

export default app;
