import { Hono } from "hono";
import { siteSettingsRoutes } from "./settings/site";
import { integrationSettingsRoutes } from "./settings/integrations";
import { paymentSettingsRoutes } from "./settings/payments";
import { systemSettingsRoutes } from "./settings/system";
import { shippingMethodsSettingsRoutes } from "./settings/shipping";
import { deliveryProvidersRoutes } from "./settings/delivery-providers";
import { heroSlidersRoutes } from "./settings/hero-sliders";
import { metaConversionsAdminRoutes } from "./settings/meta-conversions-admin";

const app = new Hono<{ Bindings: any, Variables: any }>();

// Mount the modular settings routes on the root so they match frontend expectations
// (Frontend expects /api/v1/admin/settings/stripe, not /api/v1/admin/settings/payments/stripe)
app.route("/", siteSettingsRoutes);
app.route("/", integrationSettingsRoutes);
app.route("/", paymentSettingsRoutes);
app.route("/", systemSettingsRoutes);
app.route("/shipping-methods", shippingMethodsSettingsRoutes);
app.route("/delivery-providers", deliveryProvidersRoutes);
app.route("/hero-sliders", heroSlidersRoutes);
app.route("/meta-conversions", metaConversionsAdminRoutes);

export { app as adminSettingsRoutes };
