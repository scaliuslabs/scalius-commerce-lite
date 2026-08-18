import { createRuntimeApiApp } from "./base-app";
import { agentPrincipalMiddleware } from "../middleware/agent-principal";
import { cookieOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { abandonedCheckoutsRoutes } from "../routes/abandoned-checkouts";
import { analyticsRoutes } from "../routes/analytics";
import { checkoutRoutes } from "../routes/checkout";
import { customerAuthRoutes } from "../routes/customer-auth";
import { discountRoutes } from "../routes/discounts";
import { metaConversionsRoutes } from "../routes/meta-conversions";
import { orderRoutes } from "../routes/orders";
import { storefrontAgentContextRoutes } from "../routes/storefront-agent-contexts";
import { storefrontAgentContinuationRoutes } from "../routes/storefront-agent-continuations";

const app = createRuntimeApiApp();
app.route("/discounts", discountRoutes);
app.route("/analytics", analyticsRoutes);
app.route("/meta", metaConversionsRoutes);
app.use("/storefront/agent-contexts/*", agentPrincipalMiddleware);
app.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
app.route("/storefront/agent-continuations", storefrontAgentContinuationRoutes);
app.route("/checkout", checkoutRoutes);
app.use("/customer-auth/*", cookieOriginGuardMiddleware);
app.route("/customer-auth", customerAuthRoutes);
app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
app.use("/orders/*", cookieOriginGuardMiddleware);
app.route("/orders", orderRoutes);

export default app;
