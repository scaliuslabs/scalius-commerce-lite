import { describe, expect, it } from "vitest";
import {
  STOREFRONT_CARD_LOOKS,
  STOREFRONT_CARD_SLOTS,
  STOREFRONT_CARD_VARIANTS,
  storefrontBlockVariants,
  storefrontVariantSpec,
  type StorefrontCardRenderer,
} from "./blocks";
import { STOREFRONT_TEMPLATE_IDS } from "./document";
import { EMPTY_STORE_SHAPE } from "./fit";
import { resolveStorefrontTheme } from "./resolve";
import { storefrontTemplateTheme } from "./templates";
import { STOREFRONT_IMAGE_RATIOS, STOREFRONT_IMAGE_RATIO_VALUES, STOREFRONT_RADIUS_PX } from "./tokens";

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

  it.each(STOREFRONT_IMAGE_RATIOS)("resolves the %s photo ratio token for the standard card only", (imageRatio) => {
    const theme = storefrontTemplateTheme("department-mall");
    theme.tokens.imageRatio = imageRatio;
    const standard = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard;
    expect(standard.imageRatio).toBe(imageRatio);
    expect(standard.look.image.ratio).toBe(STOREFRONT_IMAGE_RATIO_VALUES[imageRatio]);
    // Every other card keeps its own photo box whatever the template says.
    theme.blocks.card = { variant: "marketplace", settings: {} };
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard.imageRatio).toBe("square");
  });

  it("keeps the standard card as today's classic card", () => {
    expect(anatomy("standard")).toEqual({
      look: null,
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
      compare: false,
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
    expect(anatomy("detailed")).toMatchObject({
      titleLines: 3,
      body: ["swatches", "title", "options", "rating", "sold", "price", "delivery"],
    });
    // Only the spec card offers Compare.
    expect(storefrontBlockVariants("card").filter((id) => anatomy(id).compare)).toEqual(["spec"]);
  });
});

describe("card looks (fidelity AUDIT.md section 2.1)", () => {
  const owned = storefrontBlockVariants("card").filter((id) => id !== "standard");

  it("gives every card but standard its own measured look, and no two the same", () => {
    for (const id of owned) expect(anatomy(id).look, id).toEqual(STOREFRONT_CARD_LOOKS[id as keyof typeof STOREFRONT_CARD_LOOKS]);
    const looks = owned.map((id) => JSON.stringify(anatomy(id).look));
    expect(new Set(looks).size).toBe(looks.length);
    // The anatomy's title fields are derived from the look, never set apart.
    for (const id of owned) {
      const card = anatomy(id);
      expect(card.titleLines).toBe(card.look!.title.lines);
      expect(card.titleWeight).toBe({ 400: "regular", 500: "medium", 600: "strong", 700: "strong" }[card.look!.title.weight]);
    }
  });

  it("carries the reference numbers", () => {
    expect(STOREFRONT_CARD_LOOKS["tech-rounded"]).toMatchObject({ image: { ratio: 1.31, fit: "contain" }, radius: 20, surface: "raised" });
    expect(STOREFRONT_CARD_LOOKS.spec).toMatchObject({ radius: 0, surface: "flat", title: { size: { desktop: 14 }, weight: 600 }, price: { size: { desktop: 17 }, weight: 600 } });
    expect(STOREFRONT_CARD_LOOKS.portrait.image.ratio).toBe(0.75);
    expect(STOREFRONT_CARD_LOOKS["fashion-value"]).toMatchObject({ title: { lines: 1 }, price: { size: { desktop: 20 }, weight: 700 } });
    expect(STOREFRONT_CARD_LOOKS.marketplace.price).toEqual({ size: { desktop: 18, phone: 18 }, weight: 400 });
    expect(STOREFRONT_CARD_LOOKS.retail.price.size.desktop).toBe(22);
    expect(STOREFRONT_CARD_LOOKS.boutique.title).toMatchObject({ size: { desktop: 13 }, weight: 400 });
    expect(STOREFRONT_CARD_LOOKS["quick-add"].price.size).toEqual({ desktop: 18, phone: 12 });
    expect(STOREFRONT_CARD_LOOKS.detailed).toMatchObject({ title: { size: { desktop: 16, phone: 14 }, lines: 3 }, price: { size: { desktop: 28 } } });
    for (const [id, look] of Object.entries(STOREFRONT_CARD_LOOKS)) {
      // The Bangla floor on phones.
      expect(look.title.size.phone, id).toBeGreaterThanOrEqual(14);
      // Never both a border and a shadow; raised means a shadow.
      expect(["flat", "hairline", "raised"]).toContain(look.surface);
    }
  });

  it.each(STOREFRONT_TEMPLATE_IDS)("never lets the %s template flatten a card's identity", (template) => {
    for (const id of owned) {
      const theme = storefrontTemplateTheme(template);
      theme.blocks.card = { variant: id, settings: storefrontVariantSpec("card", id).defaults } as never;
      const { productCard, cardSurface } = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout;
      const look = STOREFRONT_CARD_LOOKS[id as keyof typeof STOREFRONT_CARD_LOOKS];
      expect(productCard.look, `${template}/${id}`).toEqual(look);
      expect(cardSurface).toBe({ flat: "flat", hairline: "bordered", raised: "elevated" }[look.surface]);
      expect(productCard.imageRatio).toBe(look.image.ratio < 0.9 ? "portrait" : look.image.ratio > 1.15 ? "landscape" : "square");
    }
    // The standard card takes the template's tokens and keeps the theme's type scale.
    const theme = storefrontTemplateTheme(template);
    theme.blocks.card = { variant: "standard", settings: { hoverImage: false } };
    const standard = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard.look;
    expect(standard).toEqual({
      image: { ratio: STOREFRONT_IMAGE_RATIO_VALUES[theme.tokens.imageRatio], fit: theme.tokens.imageFit },
      radius: STOREFRONT_RADIUS_PX[theme.tokens.radius],
      surface: theme.tokens.surface,
      title: null,
      price: null,
    });
  });
});
