// Route permissions for installed apps (plugins, packages/plugin-sdk/docs/apps.md):
// the management API under /api/v1/admin/apps and each app's own dashboard
// routes under /api/v1/plugins/<id>/admin/<route>/<sub path>.
//
// Naming follows the `<resource>.<action>` families: `apps.view` reads (the
// list, an app's detail, logs and deliveries, and its pages), `apps.use`
// performs an app's own mutating dashboard actions, `apps.manage` changes the
// installation (activate, settings, retry, deactivate, uninstall). Activation
// is additionally Super Admin only (enforced by the route): approving an
// app's access is approving what it may read and change.
import { PERMISSIONS } from "../permissions";
import { ANY_STAFF, type RoutePermissionMap } from "./shared";

const view = { permission: PERMISSIONS.APPS_VIEW };
const manage = { permission: PERMISSIONS.APPS_MANAGE };
const use = { allOf: [PERMISSIONS.APPS_VIEW, PERMISSIONS.APPS_USE] };

export const APP_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/apps": { GET: view },
  "/api/v1/admin/apps/*": { GET: view },
  "/api/v1/admin/apps/*/activate": { POST: manage },
  "/api/v1/admin/apps/*/deactivate": { POST: manage },
  // Features: listing is a read; turning one on is also Super Admin only
  // (enforced by the route: it approves the feature's access).
  "/api/v1/admin/apps/*/features": { GET: view },
  "/api/v1/admin/apps/*/features/*/enable": { POST: manage },
  "/api/v1/admin/apps/*/features/*/disable": { POST: manage },
  "/api/v1/admin/apps/*/settings": { PUT: manage },
  "/api/v1/admin/apps/*/uninstall": { POST: manage },
  "/api/v1/admin/apps/*/logs": { GET: view },
  // An app's icon and screenshots: any staff member, since Settings pages
  // (payments, shipping) show the icon of the app behind a method.
  "/api/v1/admin/apps/*/assets/*": { GET: { anyOf: ANY_STAFF } },
  "/api/v1/admin/apps/*/deliveries": { GET: view },
  "/api/v1/admin/apps/*/deliveries/*/retry": { POST: manage },
  // Registries, installs from them or from a package, updates and the
  // emergency stop. Trusting a developer or an unsigned package and changing
  // the trusted keys are also Super Admin only (enforced by the routes).
  "/api/v1/admin/apps/registry": { GET: view },
  "/api/v1/admin/apps/registry/settings": { GET: view, PUT: manage },
  "/api/v1/admin/apps/registry/install": { POST: manage },
  "/api/v1/admin/apps/upload": { POST: manage },
  "/api/v1/admin/apps/stop-third-party": { POST: manage },
  "/api/v1/admin/apps/*/stop": { POST: manage },
  "/api/v1/admin/apps/*/update": { POST: manage },
  // Data left by apps that are no longer installed: listing is a read;
  // deleting it is also Super Admin only (enforced by the route).
  "/api/v1/admin/apps/removed-data": { GET: view },
  "/api/v1/admin/apps/removed-data/*/delete": { POST: manage },
  // Which apps' storefront parts the store recently drew without: the app
  // pages and the theme editor (where those parts are placed) both show it.
  "/api/v1/admin/apps/storefront-problems": { GET: { anyOf: [PERMISSIONS.APPS_VIEW, PERMISSIONS.SETTINGS_THEME_EDIT] } },
  // An app's own dashboard routes: reading its pages needs apps.view; its
  // mutating actions also need apps.use.
  "/api/v1/plugins/*/admin/**": { GET: view, POST: use, PUT: use, PATCH: use, DELETE: use },
};
