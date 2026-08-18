import type { RuntimeApiApp } from "./base-app";
import { agentPrincipalMiddleware } from "../middleware/agent-principal";
import { cookieOriginGuardMiddleware } from "../middleware/cookie-origin-guard";
import { abandonedCheckoutsRoutes } from "../routes/abandoned-checkouts";
import { analyticsRoutes } from "../routes/analytics";
import { articleRoutes } from "../routes/articles";
import { attributeRoutes } from "../routes/attributes";
import { categoryRoutes } from "../routes/categories";
import { checkoutRoutes } from "../routes/checkout";
import { publicCheckoutLanguageRoutes } from "../routes/checkout-languages";
import { collectionRoutes } from "../routes/collections";
import { customerAuthRoutes } from "../routes/customer-auth";
import { discountRoutes } from "../routes/discounts";
import { footerRoutes } from "../routes/footer";
import { headerRoutes } from "../routes/header";
import { heroRoutes } from "../routes/hero";
import { locationRoutes } from "../routes/locations";
import { serveMediaRoute } from "../routes/media-server";
import { metaConversionsRoutes } from "../routes/meta-conversions";
import { navigationRoutes } from "../routes/navigation";
import { orderRoutes } from "../routes/orders";
import { pagesRoutes } from "../routes/pages";
import { partytownProxyRoutes } from "../routes/partytown-proxy";
import { productRoutes } from "../routes/products";
import { searchRoutes } from "../routes/search";
import { seoRoutes } from "../routes/seo";
import { shippingMethodRoutes } from "../routes/shipping-methods";
import { storefrontAgentContextRoutes } from "../routes/storefront-agent-contexts";
import { storefrontAgentContinuationRoutes } from "../routes/storefront-agent-continuations";
import { storefrontRoutes } from "../routes/storefront";

export function registerPublicRoutes(app: RuntimeApiApp): void {
  app.get("/", (c) =>
    c.json({
      success: true,
      message: "Welcome to Scalius Commerce API",
      version: process.env.npm_package_version || "1.0.0",
      environment: process.env.NODE_ENV || "development",
    }),
  );

  app.route("/attributes", attributeRoutes);
  app.route("/collections", collectionRoutes);
  app.route("/hero", heroRoutes);
  app.route("/search", searchRoutes);
  app.route("/header", headerRoutes);
  app.route("/navigation", navigationRoutes);
  app.route("/footer", footerRoutes);
  app.route("/pages", pagesRoutes);
  app.route("/articles", articleRoutes);
  app.route("/discounts", discountRoutes);
  app.route("/analytics", analyticsRoutes);
  app.route("/meta", metaConversionsRoutes);
  app.route("/storefront", storefrontRoutes);
  app.use("/storefront/agent-contexts/*", agentPrincipalMiddleware);
  app.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
  app.route("/storefront/agent-continuations", storefrontAgentContinuationRoutes);
  app.route("/checkout", checkoutRoutes);
  app.use("/customer-auth/*", cookieOriginGuardMiddleware);
  app.route("/customer-auth", customerAuthRoutes);
  app.route("/checkout-languages", publicCheckoutLanguageRoutes);
  app.route("/abandoned-checkouts", abandonedCheckoutsRoutes);
  app.route("/locations", locationRoutes);
  app.route("/shipping-methods", shippingMethodRoutes);
  app.route("/seo", seoRoutes);
  app.route("/__ptproxy", partytownProxyRoutes);

  app.use("/orders/*", cookieOriginGuardMiddleware);
  app.route("/products", productRoutes);
  app.route("/categories", categoryRoutes);
  app.route("/orders", orderRoutes);

  if (process.env.NODE_ENV === "development") {
    app.route("/media", serveMediaRoute);
  }
}
