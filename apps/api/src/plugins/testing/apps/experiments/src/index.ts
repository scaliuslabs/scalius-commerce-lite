// acme.experiments: the client-side A/B test app (packages/plugin-sdk/docs/storefront.md,
// "Experiments"). The product page's buy box shows one of two delivery
// notes. The page is the same cached HTML for every buyer: the island picks
// the visitor's variant in the browser (`experimentVariant` over the store's
// visitor id), shows it and publishes an exposure; the pixel, which hears the
// same visitor id on every event, sends the exposure and each completed
// order to the app's collector, so a conversion is attributed to the variant
// the buyer saw. Both run only once the buyer allows analytics; before that
// (or without consent) every buyer sees the control and nothing is sent.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export { EXPERIMENT } from "./experiment";

export const manifest = {
  id: "acme.experiments",
  name: "Acme Experiments",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Tests two delivery notes on your product pages and tells you which sells more.",
  author: { name: "Acme" },
  categories: ["marketing"],
  storefront: {
    components: [{ type: "delivery_note", name: "Delivery note test", targets: ["product.buy_box.after"], settings: [] }],
    islands: [{ name: "note", description: "Shows the visitor's variant and records the exposure." }],
    pixel: { consent: "analytics", events: ["app_event", "checkout_completed"] },
    connect: ["ab.acme.example"],
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
