import { Hono } from "hono";
import { siteSettingsRoutes } from "./settings/site";
import { integrationSettingsRoutes } from "./settings/integrations";
import { paymentSettingsRoutes } from "./settings/payments";
import { systemSettingsRoutes } from "./settings/system";

const app = new Hono<{ Bindings: any, Variables: any }>();

// Mount the modular settings routes
app.route("/", siteSettingsRoutes);
app.route("/integrations", integrationSettingsRoutes);
app.route("/payments", paymentSettingsRoutes);
app.route("/system", systemSettingsRoutes);

export { app as adminSettingsRoutes };
