import { createRuntimeApiApp } from "./base-app";
import { checkoutRoutes } from "../routes/checkout";
import { checkoutGiftCardRoutes } from "../routes/checkout-gift-cards";
import { publicCheckoutLanguageRoutes } from "../routes/checkout-languages";
import { footerRoutes } from "../routes/footer";
import { headerRoutes } from "../routes/header";
import { heroRoutes } from "../routes/hero";
import { locationRoutes } from "../routes/locations";
import { navigationRoutes } from "../routes/navigation";
import { seoRoutes } from "../routes/seo";
import { shippingMethodRoutes } from "../routes/shipping-methods";
import { storefrontRoutes } from "../routes/storefront";
import { platformRoutes } from "../routes/platform";

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
app.route("/platform", platformRoutes);
// Checkout settings are a public read every storefront render batches with
// the layout; serving them here keeps the buyer graph (orders, customer
// auth, agent contexts) out of page renders.
app.route("/checkout", checkoutRoutes);
app.route("/checkout/gift-cards", checkoutGiftCardRoutes);
app.route("/checkout-languages", publicCheckoutLanguageRoutes);
app.route("/locations", locationRoutes);
app.route("/shipping-methods", shippingMethodRoutes);
app.route("/seo", seoRoutes);

export default app;
