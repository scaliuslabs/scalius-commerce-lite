import { createAdminRuntimeApiApp } from "./admin-base-app";
import { abandonedCheckoutsRoutes } from "../routes/abandoned-checkouts";
import { checkoutLanguageRoutes } from "../routes/checkout-languages";
import { adminNavigationRoutes } from "../routes/admin/navigation";
import { adminPageRoutes } from "../routes/admin/pages";
import { adminSettingsRoutes } from "../routes/admin/settings";
import { adminLocationRoutes } from "../routes/admin/settings/delivery-locations";

const app = createAdminRuntimeApiApp();
app.route("/admin/pages", adminPageRoutes);
app.route("/admin/navigation", adminNavigationRoutes);
app.route("/admin/settings", adminSettingsRoutes);
app.route("/admin/settings/delivery-locations", adminLocationRoutes);
app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
app.route("/admin/settings/abandoned-checkouts", abandonedCheckoutsRoutes);

export default app;
