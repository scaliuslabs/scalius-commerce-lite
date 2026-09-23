import type { RuntimeApiApp } from "./base-app";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { dashboardOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { webhookBodyLimitMiddleware } from "../middleware/webhook-body-limit";
import { agentArtifactRoutes } from "../routes/agent-artifacts";
import { agentAuthRoutes } from "../routes/agent-auth";
import authRoutes from "../routes/auth";
import { authSetupRoutes } from "../routes/admin/auth-management";
import { cacheControlRoutes } from "../routes/cache";
import { paymentRoutes } from "../routes/payment/payment-routes";
import { pathaoWebhookRoutes } from "../routes/webhooks/pathao";
import { paymentWebhookRoutes } from "../routes/webhooks/payments";
import { steadfastWebhookRoutes } from "../routes/webhooks/steadfast";

export function registerSystemRoutes(app: RuntimeApiApp): void {
  app.route("/auth", authRoutes);
  app.route("/agent-auth", agentAuthRoutes);
  app.route("/agent-artifacts", agentArtifactRoutes);

  app.use("/webhooks/*", webhookBodyLimitMiddleware);
  app.route("/webhooks/pathao", pathaoWebhookRoutes);
  app.route("/webhooks/steadfast", steadfastWebhookRoutes);
  // Payment gateways: /webhooks/{provider}. Registered after the courier routes.
  app.route("/webhooks", paymentWebhookRoutes);

  app.use("/cache/*", dashboardOriginGuardMiddleware);
  app.use("/cache/*", adminAuthMiddleware);
  app.route("/cache", cacheControlRoutes);

  app.route("/setup", authSetupRoutes);
  app.route("/payment", paymentRoutes);
}
