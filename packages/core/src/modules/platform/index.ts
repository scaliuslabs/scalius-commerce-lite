// Platform domain: the deployment's public origins (storefront, API,
// dashboard, media), CORS and identity handoff, stored in the platform
// settings document and resolved once per Worker invocation. Kept apart
// from settings so the Worker entry loads only this.
export * from "./platform-settings.service";
