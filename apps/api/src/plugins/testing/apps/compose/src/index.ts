// acme.compose: the composition test app (docs/STOREFRONT-COMPONENTS.md). It
// uses every extension point a second app needs without core edits or
// reading another app's fields: badges and a line on every product card
// (whoever draws the card), a header skin that draws from the header's
// facts (menu photos, search within a category, the market, order routes,
// signed-in parts) with a merchant-picked promo image, a listing skin with
// the category's children, a buy-box line with the SKU code and EMI, a heavy
// part deferred past the first paint, the cart drawer and the cart page, and
// one component that always fails (the store must draw on without it).

import { definePlugin, PLUGIN_API_VERSION, ui, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.compose",
  name: "Compose",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Seller badges on every card, a marketplace header, and delivery notes in the cart.",
  author: { name: "Acme" },
  categories: ["store-design"],
  settings: [{ key: "free_over", label: "Free delivery over", type: "text", default: "৳ 2,000", maxLength: 40 }],
  storefront: {
    components: [
      {
        type: "seller_badge", name: "Seller badge", targets: ["product_card.badges"],
        settings: [{ key: "label", label: "Badge", type: "text", default: "Acme Market", maxLength: 40 }],
      },
      {
        type: "card_line", name: "Delivery line", targets: ["product_card.meta"],
        settings: [{ key: "text", label: "Text", type: "text", default: "Ships from Dhaka", maxLength: 60 }],
      },
      { type: "product_code", name: "Product code and EMI", targets: ["product.buy_box.after"], settings: [] },
      { type: "spec_wall", name: "Specification wall", targets: ["product.below"], settings: [] },
      { type: "broken", name: "Always fails", targets: ["header.actions"], settings: [] },
    ],
    skins: [
      {
        id: "compose_header", target: "header", name: "Marketplace header",
        settings: [
          { key: "promo", label: "Promo image", type: "image" },
          { key: "promo_link", label: "Promo link", type: "link", default: "/search" },
        ],
      },
      { id: "compose_listing", target: "listing_main", name: "Department listing", settings: [] },
    ],
    islands: [{ name: "wall", description: "Opens the specification wall's rows." }],
    extensions: [
      { target: "cart_drawer.footer" },
      { target: "cart.page.below" },
    ],
  },
} satisfies PluginManifestInput;

export default definePlugin({
  manifest,
  extensions: {
    "cart_drawer.footer": (_input, settings) => ({
      ui: ui.view([ui.text(`Free delivery over ${String(settings.free_over ?? "")}`)]),
    }),
    "cart.page.below": (input) => ({
      ui: ui.view([ui.text(`${input.cart?.lines.length ?? 0} items ship from Dhaka.`)]),
    }),
  },
});
