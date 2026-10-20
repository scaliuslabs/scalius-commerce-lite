import { createAdminRuntimeApiApp } from "./admin-base-app";
import { checkoutLanguageRoutes } from "../routes/checkout-languages";
import { adminNavigationRoutes } from "../routes/admin/navigation";
import { adminPageRoutes } from "../routes/admin/pages";
import { adminTranslationRoutes } from "../routes/admin/translations";
import { customFieldDefinitionRoutes, customFieldValueRoutes } from "../routes/admin/custom-fields";
import { adminObjectRoutes } from "../routes/admin/objects";
import { adminSettingsRoutes } from "../routes/admin/settings";
import { adminLocationRoutes } from "../routes/admin/settings/delivery-locations";

const app = createAdminRuntimeApiApp();
app.route("/admin/pages", adminPageRoutes);
app.route("/admin/navigation", adminNavigationRoutes);
app.route("/admin/translations", adminTranslationRoutes);
app.route("/admin/custom-field-definitions", customFieldDefinitionRoutes);
app.route("/admin/custom-fields", customFieldValueRoutes);
app.route("/admin/objects", adminObjectRoutes);
app.route("/admin/settings", adminSettingsRoutes);
app.route("/admin/settings/delivery-locations", adminLocationRoutes);
app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);

export default app;
