// The platform contract the authoring tools check an app against (manifest,
// handlers, images, storefront rules and fixtures). `pnpm plugin` compiles it
// from this checkout (scripts/plugin-host.mjs); the SDK's `scalius-plugin`
// carries it built in (scripts/plugin-host.sdk.mjs).
export * from "@scalius/shared/plugins";
export { pluginObjectPatternIssues } from "@scalius/shared/plugins/object-patterns";
export { checkPluginAsset, checkStorefrontPublicFile } from "@scalius/shared/plugins/assets";
export { storefrontTemplateCardFieldNotes } from "@scalius/shared/plugins/storefront-template-fields";
export { storefrontModuleFieldNotes, storefrontPortabilityNotes } from "@scalius/shared/plugins/storefront-portability";
export { storefrontDefinitionOf } from "../src/storefront/define";
export { checkSkinHtml, checkStorefrontHeaderHtml, FIXTURE_STORES, fixtureContext, fixtureProductCard, fixtureProductPage, fixtureSkinData, fixtureStore, storefrontShown } from "../src/storefront/testing";
