import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import compose from "./index";

const buyer = { language: "en", locale: "en-BD", currency: "BDT", cart: null, attributes: {}, order: null, customer: null };
const text = (value: string) => ({ ui: { version: 1, root: { type: "stack", children: [{ type: "text", text: value }] } } });

describe("acme.compose", () => {
  it("declares card slots, unit skins with an image setting, and the new UI slots", () => {
    const { manifest } = createPluginTestHarness(compose);
    expect(manifest.storefront.components.map((component) => component.targets).flat())
      .toEqual(["product_card.badges", "product_card.meta", "product.buy_box.after", "product.below", "header.actions"]);
    expect(manifest.storefront.skins.find((skin) => skin.target === "header")?.settings.find((field) => field.key === "promo")?.type).toBe("image");
    expect(manifest.storefront.extensions.map((extension) => extension.target)).toEqual(["cart_drawer.footer", "cart.page.below"]);
  });

  it("draws the cart drawer's footer and the cart page's last block as text", async () => {
    const harness = createPluginTestHarness(compose, { settings: { free_over: "৳ 2,000" } });
    expect((await harness.extension({ ...buyer, target: "cart_drawer.footer" })).value).toEqual(text("Free delivery over ৳ 2,000"));
    expect((await harness.extension({ ...buyer, target: "cart.page.below" })).value).toEqual(text("0 items ship from Dhaka."));
  });
});
