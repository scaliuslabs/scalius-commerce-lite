import { ADMIN_MIDDLEWARE } from "./admin-base-app";
import { buildRouteGroupApp, type RouteGroupParts } from "./route-groups";
import { checkoutLanguageRoutes } from "../routes/checkout-languages";
import { adminNavigationRoutes } from "../routes/admin/navigation";
import { adminPageRoutes } from "../routes/admin/pages";
import { adminTranslationRoutes } from "../routes/admin/translations";
import { customFieldDefinitionRoutes, customFieldValueRoutes } from "../routes/admin/custom-fields";
import { adminObjectRoutes } from "../routes/admin/objects";
import { adminSettingsRoutes } from "../routes/admin/settings";
import { adminLocationRoutes } from "../routes/admin/settings/delivery-locations";

export const adminContentParts: RouteGroupParts<"admin-content"> = {
  routers: {
    adminObjectRoutes,
    adminPageRoutes,
    adminNavigationRoutes,
    adminTranslationRoutes,
    adminSettingsRoutes,
    customFieldDefinitionRoutes,
    customFieldValueRoutes,
    adminLocationRoutes,
    checkoutLanguageRoutes,
  },
  middleware: ADMIN_MIDDLEWARE,
};

export default buildRouteGroupApp("admin-content", adminContentParts);
