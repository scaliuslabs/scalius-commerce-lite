import type { RuntimeApiApp } from "./base-app";
import { adminAuthMiddleware } from "../middleware/admin-auth";
import { cookieOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { webhookBodyLimitMiddleware } from "../middleware/webhook-body-limit";
import { agentArtifactRoutes } from "../routes/agent-artifacts";
import { agentAuthRoutes } from "../routes/agent-auth";
import authRoutes from "../routes/auth";
import { authSetupRoutes } from "../routes/admin/auth-management";
import { cacheControlRoutes } from "../routes/cache";
import { polarPaymentRoutes } from "../routes/payment/polar-routes";
import { sslcommerzPaymentRoutes } from "../routes/payment/sslcommerz-routes";
import { stripePaymentRoutes } from "../routes/payment/stripe-routes";
import { pathaoWebhookRoutes } from "../routes/webhooks/pathao";
import { polarWebhookRoutes } from "../routes/webhooks/polar";
import { sslcommerzWebhookRoutes } from "../routes/webhooks/sslcommerz";
import { steadfastWebhookRoutes } from "../routes/webhooks/steadfast";
import { stripeWebhookRoutes } from "../routes/webhooks/stripe";

export function registerSystemRoutes(app: RuntimeApiApp): void {
  app.route("/auth", authRoutes);
  app.route("/agent-auth", agentAuthRoutes);
  app.route("/agent-artifacts", agentArtifactRoutes);

  app.use("/webhooks/*", webhookBodyLimitMiddleware);
  app.route("/webhooks/stripe", stripeWebhookRoutes);
  app.route("/webhooks/sslcommerz", sslcommerzWebhookRoutes);
  app.route("/webhooks/polar", polarWebhookRoutes);
  app.route("/webhooks/pathao", pathaoWebhookRoutes);
  app.route("/webhooks/steadfast", steadfastWebhookRoutes);

  app.use("/cache/*", cookieOriginGuardMiddleware);
  app.use("/cache/*", adminAuthMiddleware);
  app.route("/cache", cacheControlRoutes);

  app.route("/setup", authSetupRoutes);
  app.route("/payment/stripe", stripePaymentRoutes);
  app.route("/payment/sslcommerz", sslcommerzPaymentRoutes);
  app.route("/payment/polar", polarPaymentRoutes);
}
