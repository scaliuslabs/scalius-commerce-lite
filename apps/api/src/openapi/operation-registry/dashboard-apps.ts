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
  // Features (`manifest.features`): reading them is a plain read; turning one
  // on approves its access, a Super Admin's consent in the dashboard like
  // activation; turning one off only narrows access, so agents may.
  "dashboard.apps.features_list": { limits: { response: 65_536 } },
  "dashboard.apps.feature_enable": {
    exposure: "excluded",
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 131_072, response: 65_536 },
    reason: "Turning on an app feature approves its access to store data and outside services: a Super Admin's consent in the dashboard. Agents list features and turn them off.",
  },
  "dashboard.apps.feature_disable": {
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
  // Data left by apps that are no longer installed. Deleting it cannot be
  // undone: destructive (so confirmed in plain words), it runs alone, and the
  // route also requires the owner to be a Super Admin.
  "dashboard.apps.removed_data_list": { limits: { response: 65_536 } },
  "dashboard.apps.removed_data_delete": {
    risk: "destructive",
    batch: "forbidden",
    revision: "required",
    limits: { request: 4_096, response: 4_096 },
  },
  "dashboard.apps.removed_data_hand_over": {
    exposure: "excluded",
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 4_096, response: 4_096 },
    reason: "Letting another release's code read and change an app's kept data is a Super Admin's trust decision in the dashboard, like trusting a developer key.",
  },
  "dashboard.apps.logs_list": { limits: { response: 65_536 } },
  "dashboard.apps.deliveries_list": { limits: { response: 65_536 } },
  "dashboard.apps.delivery_retry": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { request: 16_384, response: 16_384 },
  },
  // Registries, installs, updates and the emergency stop
  // (docs/platform/PLUGINS.md, "Registry", "Quotas and kill switch").
  "dashboard.apps.registry_list": { openWorld: true, limits: { response: 65_536 } },
  "dashboard.apps.registry_settings_get": { limits: { response: 65_536 } },
  "dashboard.apps.registry_settings_update": {
    exposure: "excluded",
    risk: "security",
    batch: "forbidden",
    revision: "required",
    limits: { request: 65_536, response: 65_536 },
    reason: "Choosing which developers and registries the store trusts is a Super Admin's decision in the dashboard; agents can read it.",
  },
  "dashboard.apps.registry_install": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    limits: { request: 16_384, response: 65_536 },
  },
  "dashboard.apps.update": {
    risk: "security",
    openWorld: true,
    batch: "forbidden",
    revision: "required",
    limits: { request: 16_384, response: 65_536 },
  },
  "dashboard.apps.upload": {
    exposure: "excluded",
    reason: "A package file upload, and the trust choices that may come with it, are a person's in the dashboard; agents install from a registry (dashboard.apps.registry_install).",
  },
  "dashboard.apps.stop": {
    risk: "security",
    batch: "forbidden",
    limits: { request: 4_096, response: 65_536 },
  },
  "dashboard.apps.stop_third_party": {
    risk: "security",
    batch: "forbidden",
    limits: { request: 4_096, response: 16_384 },
  },
} as const satisfies Record<string, OperationRegistryEntry>;
