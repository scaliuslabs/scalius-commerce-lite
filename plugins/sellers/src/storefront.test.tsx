import { describe, expect, it } from "vitest";
import { fixtureProductPage, renderBlock, renderSection, storefrontShown } from "@scalius/plugin-sdk/storefront/testing";
import storefront from "./storefront";

const fields = { "scalius.sellers.seller_name": "Acme Audio", "scalius.sellers.seller_handle": "acme-audio" };

function shown(html: string) {
  const result = storefrontShown(html, "scalius.sellers");
  expect(result.dropped).toBe(0);
  return result.html;
}

describe("scalius.sellers storefront", () => {
  it("shows Sold by in the buy box with a link to the seller's page", () => {
    const html = shown(renderBlock(storefront, "sold_by", { label: "Sold by" }, fixtureProductPage({ fields }), { target: "product.buy-box" }));
    expect(html).toContain("Sold by");
    expect(html).toContain('href="/apps/scalius.sellers/store/acme-audio"');
  });

  it("draws nothing for a product the store sells itself", () => {
    expect(renderBlock(storefront, "sold_by", { label: "" }, fixtureProductPage())).toBe("");
    expect(renderBlock(storefront, "about_seller", {}, fixtureProductPage())).toBe("");
  });

  it("introduces the seller below the product", () => {
    expect(shown(renderBlock(storefront, "about_seller", {}, fixtureProductPage({ fields })))).toContain("Visit Acme Audio");
  });

  it("lists published seller profiles in the directory", () => {
    const html = renderSection(storefront, "seller_directory", { heading: "Our sellers", text: "", apply_label: "Sell with us" });
    expect(shown(html)).toContain('href="/apps/scalius.sellers/apply"');
  });
});
