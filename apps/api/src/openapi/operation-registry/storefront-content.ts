// Agent operation registry rows for the storefront content, layout, SEO and analytics routes.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_CONTENT_OPERATIONS = {
  "storefront.analytics_configurations.get_configurations": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Processed analytics snippets and trusted custom browser code are rendering infrastructure, not structured agent data.",
  },
  "storefront.articles.get_by_slug": {},
  "storefront.articles.list": {},
  "storefront.hero_sliders.get": {},
  "storefront.hero_sliders.list": {},
  "storefront.batch.get": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Storefront render transport; every part is its own public read operation, which agents call directly.",
  },
  "storefront.homepage.get": { limits: { request: 16_384 } },
  "storefront.layout.footer_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Compatibility alias; storefront.layout.get is the canonical buyer-shell authority.",
  },
  "storefront.layout.get": { limits: { request: 16_384 } },
  "storefront.layout.header_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "Compatibility alias; storefront.layout.get is the canonical buyer-shell authority.",
  },
  "storefront.meta_events.events": {
    exposure: "excluded",
    openWorld: true,
    reason:
      "Browser analytics ingestion forwards browser-derived events and user data to Meta CAPI; agents must not fabricate browser telemetry.",
  },
  "storefront.navigation.categories_get": {},
  "storefront.navigation.get": {},
  "storefront.navigation.items_list": {},
  "storefront.navigation.menu_get": {},
  "storefront.navigation.menu_get_by_id": {},
  "storefront.navigation.placements_list": {},
  "storefront.pages.get_by_id": {},
  "storefront.pages.get_by_slug": {},
  "storefront.pages.list": {},
  "storefront.pages.render_by_slug_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Storefront render-helper duplicate; use storefront.pages.get_by_slug as the canonical page-content authority.",
  },
  "storefront.platform.get": { limits: { request: 16_384, response: 8_192 } },
  "storefront.ptproxy.get_ptproxy": {
    exposure: "excluded",
    principals: ["internal"],
    openWorld: true,
    reason:
      "Allowlisted Partytown script reverse proxy is browser transport infrastructure, not a semantic agent operation.",
  },
  "storefront.seo.get": { limits: { request: 16_384, response: 32_768 } },
} satisfies Record<string, OperationRegistryEntry>;
