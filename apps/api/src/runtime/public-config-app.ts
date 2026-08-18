import { createRuntimeApiApp } from "./base-app";
import { publicCheckoutLanguageRoutes } from "../routes/checkout-languages";
import { footerRoutes } from "../routes/footer";
import { headerRoutes } from "../routes/header";
import { heroRoutes } from "../routes/hero";
import { locationRoutes } from "../routes/locations";
import { navigationRoutes } from "../routes/navigation";
import { seoRoutes } from "../routes/seo";
import { shippingMethodRoutes } from "../routes/shipping-methods";
import { storefrontRoutes } from "../routes/storefront";

const app = createRuntimeApiApp();
app.get("/", (c) => c.json({
  success: true,
  message: "Welcome to Scalius Commerce API",
  version: process.env.npm_package_version || "1.0.0",
  environment: process.env.NODE_ENV || "development",
}));
app.route("/hero", heroRoutes);
app.route("/header", headerRoutes);
app.route("/navigation", navigationRoutes);
app.route("/footer", footerRoutes);
app.route("/storefront", storefrontRoutes);
app.route("/checkout-languages", publicCheckoutLanguageRoutes);
app.route("/locations", locationRoutes);
app.route("/shipping-methods", shippingMethodRoutes);
app.route("/seo", seoRoutes);

export default app;
