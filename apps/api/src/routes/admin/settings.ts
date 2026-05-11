import { OpenAPIHono } from "@hono/zod-openapi";
import { siteSettingsRoutes } from "./settings/site";
import { paymentSettingsRoutes } from "./settings/payments";
import { systemSettingsRoutes } from "./settings/system";
import { shippingMethodsSettingsRoutes } from "./settings/shipping";
import { deliveryProvidersRoutes } from "./settings/delivery-providers";
import { heroSlidersRoutes } from "./settings/hero-sliders";
import { metaConversionsAdminRoutes } from "./settings/meta-conversions-admin";
import { notificationChannelsRoutes } from "./settings/notification-channels";
import { smsSettingsRoutes } from "./settings/sms";
import { businessSettingsRoutes } from "./settings/business";
import { aiSettingsRoutes } from "./settings/ai";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Mount the modular settings routes on the root so they match frontend expectations
// (Frontend expects /api/v1/admin/settings/stripe, not /api/v1/admin/settings/payments/stripe)
app.route("/", siteSettingsRoutes);
app.route("/", businessSettingsRoutes);
app.route("/", paymentSettingsRoutes);
app.route("/", systemSettingsRoutes);
app.route("/shipping-methods", shippingMethodsSettingsRoutes);
app.route("/delivery-providers", deliveryProvidersRoutes);
app.route("/hero-sliders", heroSlidersRoutes);
app.route("/meta-conversions", metaConversionsAdminRoutes);
app.route("/notification-channels", notificationChannelsRoutes);
app.route("/", smsSettingsRoutes);
app.route("/", aiSettingsRoutes);

export { app as adminSettingsRoutes };
