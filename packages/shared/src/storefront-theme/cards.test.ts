import { describe, expect, it } from "vitest";
import {
  STOREFRONT_CARD_SLOTS,
  STOREFRONT_CARD_VARIANTS,
  storefrontBlockVariants,
  storefrontVariantSpec,
  type StorefrontCardRenderer,
} from "./blocks";
import { EMPTY_STORE_SHAPE } from "./fit";
import { resolveStorefrontTheme } from "./resolve";
import { storefrontTemplateTheme } from "./templates";
import { STOREFRONT_IMAGE_RATIOS } from "./tokens";

const anatomy = (id: string): StorefrontCardRenderer =>
  (storefrontVariantSpec("card", id).renders as (settings: unknown) => StorefrontCardRenderer)(
    storefrontVariantSpec("card", id).defaults,
  );
const pairs = (id: string) => storefrontVariantSpec("card", id).contrastPairs.map((pair) => pair.join("/"));

describe("card anatomy", () => {
  it.each(storefrontBlockVariants("card"))("%s: one title, one price, known facts once each", (id) => {
    const { body } = anatomy(id);
    expect(body.filter((part) => part === "title")).toHaveLength(1);
    expect(body.filter((part) => part === "price")).toHaveLength(1);
    expect(new Set(body).size).toBe(body.length);
    for (const part of body) expect(["title", "price", ...STOREFRONT_CARD_SLOTS]).toContain(part);
  });

  it.each(storefrontBlockVariants("card"))("%s: declares every colour role it paints", (id) => {
    const card = anatomy(id);
    if (card.priceTone === "primary" || card.action === "outline") expect(pairs(id)).toContain("primary/card");
    // The sale colour as text on the card: a sale-toned price, a discount
    // beside the price in words, or the savings line.
    const saleText = card.priceTone === "sale"
      || (card.badge === "price" && card.discount !== "off")
      || card.body.includes("savings");
    if (saleText) expect(pairs(id)).toContain("destructive/card");
  });

  it.each(STOREFRONT_IMAGE_RATIOS)("resolves the %s photo ratio token for the card", (imageRatio) => {
    const theme = storefrontTemplateTheme("marketplace");
    theme.tokens.imageRatio = imageRatio;
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard.imageRatio).toBe(imageRatio);
  });

  it("keeps the standard card as today's classic card", () => {
    expect(anatomy("standard")).toEqual({
      quickBuy: false,
      badge: "image",
      hoverImage: false,
      discount: "percent",
      titleLines: 2,
      titleWeight: "medium",
      priceTone: "ink",
      body: ["title", "price"],
      action: "block",
      actionLabel: "add-to-cart",
    });
  });

  it("puts each measured anatomy on its own id", () => {
    const shapes = Object.keys(STOREFRONT_CARD_VARIANTS).map((id) => JSON.stringify({ ...anatomy(id), hoverImage: null }));
    expect(new Set(shapes).size).toBe(shapes.length);
    // A few measured facts (SYNTHESIS.md section 2.4).
    expect(anatomy("spec").body).toEqual(["title", "key-specs", "price", "emi"]);
    expect(anatomy("retail").body[0]).toBe("price");
    expect(anatomy("quick-add")).toMatchObject({ action: "round", body: ["price", "title", "pack-size", "delivery"] });
    expect(anatomy("fashion-value")).toMatchObject({ action: "round", titleLines: 1 });
    expect(anatomy("marketplace")).toMatchObject({ quickBuy: false, priceTone: "primary" });
  });
});
