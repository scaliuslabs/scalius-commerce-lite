// Agent operation registry rows for installed apps (plugins,
// docs/platform/PLUGINS.md). An app reads and changes store data under its
// grant, so every change to an installation is a security operation that runs
// alone; approving an app's access is a Super Admin's decision in the
// dashboard and is not an agent capability. Plugins can call none of these.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_APP_OPERATIONS = {
  "dashboard.apps.list": { limits: { response: 65_536 } },
  "dashboard.apps.surfaces": { limits: { response: 65_536 } },
  "dashboard.apps.get": { limits: { response: 65_536 } },
  "dashboard.apps.asset_get": {
    exposure: "excluded",
    reason: "Image bytes for the dashboard's app cards and app pages; agents read an app's listing from dashboard.apps.list and dashboard.apps.get.",
  },
  "dashboard.apps.activate": {
    exposure: "excluded",
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 131_072, response: 65_536 },
    reason: "Approving an app's access to store data, network hosts and the storefront is a Super Admin's consent in the dashboard; agents can read the request and stop or remove apps.",
  },
  "dashboard.apps.deactivate": {
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 16_384, response: 65_536 },
  },
  "dashboard.apps.settings_update": {
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 131_072, response: 65_536 },
  },
  "dashboard.apps.uninstall": {
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 16_384, response: 16_384 },
  },
  "dashboard.apps.logs_list": { limits: { response: 65_536 } },
  "dashboard.apps.deliveries_list": { limits: { response: 65_536 } },
  "dashboard.apps.delivery_retry": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
  },
} as const satisfies Record<string, OperationRegistryEntry>;
