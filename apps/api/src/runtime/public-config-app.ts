import { Hono } from "hono";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { checkoutRoutes } from "../routes/checkout";
import { checkoutGiftCardRoutes } from "../routes/checkout-gift-cards";
import { publicCheckoutLanguageRoutes } from "../routes/checkout-languages";
import { locationRoutes } from "../routes/locations";
import { addressRuleRoutes } from "../routes/address-rules";
import { addressAutocompleteRoutes } from "../routes/address-autocomplete";
import { navigationRoutes } from "../routes/navigation";
import { seoRoutes } from "../routes/seo";
import { shippingMethodRoutes } from "../routes/shipping-methods";
import { storefrontRoutes } from "../routes/storefront";
import { platformRoutes } from "../routes/platform";

/** GET /api/v1/: the API's greeting. */
const welcomeRoutes = new Hono<{ Bindings: Env }>().get("/", (c) => c.json({
  success: true,
  message: "Welcome to Scalius Commerce API",
  version: process.env.npm_package_version || "1.0.0",
  environment: process.env.NODE_ENV || "development",
}));

export const publicConfigParts: RouteGroupParts<"public-config"> = {
  routers: {
    welcomeRoutes,
    navigationRoutes,
    storefrontRoutes,
    platformRoutes,
    checkoutRoutes,
    checkoutGiftCardRoutes,
    publicCheckoutLanguageRoutes,
    locationRoutes,
    addressAutocompleteRoutes,
    addressRuleRoutes,
    shippingMethodRoutes,
    seoRoutes,
  },
  middleware: {},
};

export default buildRouteGroupApp("public-config", publicConfigParts);
