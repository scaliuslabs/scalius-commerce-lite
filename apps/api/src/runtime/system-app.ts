import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { privateNoStore } from "../middleware/private-no-store";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { webhookBodyLimitMiddleware } from "../middleware/webhook-body-limit";
import { agentArtifactRoutes } from "../routes/agent-artifacts";
import { agentAuthRoutes } from "../routes/agent-auth";
import authRoutes from "../routes/auth";
import { authSetupRoutes } from "../routes/admin/auth-management";
import { cacheControlRoutes } from "../routes/cache";
import { paymentRoutes } from "../routes/payment/payment-routes";
import { courierWebhookRoutes } from "../routes/webhooks/couriers";
import { paymentWebhookRoutes } from "../routes/webhooks/payments";

export const systemParts: RouteGroupParts<"system"> = {
  routers: {
    authRoutes,
    agentAuthRoutes,
    agentArtifactRoutes,
    courierWebhookRoutes,
    paymentWebhookRoutes,
    cacheControlRoutes,
    authSetupRoutes,
    paymentRoutes,
  },
  middleware: {
    webhookBodyLimit: webhookBodyLimitMiddleware,
    privateNoStore,
    dashboardOriginGuard: dashboardOriginGuardMiddleware,
    adminAuth: adminAuthMiddleware,
  },
};

export default buildRouteGroupApp("system", systemParts);
