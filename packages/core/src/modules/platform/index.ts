// Platform domain: the deployment's public origins (storefront, API,
// dashboard, media), CORS, identity handoff and the store defaults (time
// zone, units), stored in the platform settings document and resolved once
// per Worker invocation. Kept apart from settings so the Worker entry loads
// only this.
export * from "./document";
export * from "./platform-settings.service";
export * from "./store-defaults.service";
