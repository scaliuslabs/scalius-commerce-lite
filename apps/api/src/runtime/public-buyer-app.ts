import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { agentPrincipalMiddleware } from "../middleware/agent-principal";
import { cookieOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { abandonedCheckoutsRoutes } from "../routes/abandoned-checkouts";
import { analyticsRoutes } from "../routes/analytics";
import { customerAuthRoutes } from "../routes/customer-auth";
import { discountRoutes } from "../routes/discounts";
import { marketingRoutes } from "../routes/marketing";
import { metaConversionsRoutes } from "../routes/meta-conversions";
import { orderRoutes } from "../routes/storefront-orders";
import { storefrontAgentContextRoutes } from "../routes/storefront-agent-contexts";
import { storefrontAgentContinuationRoutes } from "../routes/storefront-agent-continuations";

export const publicBuyerParts: RouteGroupParts<"public-buyer"> = {
  routers: {
    discountRoutes,
    analyticsRoutes,
    metaConversionsRoutes,
    storefrontAgentContextRoutes,
    storefrontAgentContinuationRoutes,
    customerAuthRoutes,
    abandonedCheckoutsRoutes,
    marketingRoutes,
    orderRoutes,
  },
  middleware: {
    agentPrincipal: agentPrincipalMiddleware,
    cookieOriginGuard: cookieOriginGuardMiddleware,
  },
};

export default buildRouteGroupApp("public-buyer", publicBuyerParts);
