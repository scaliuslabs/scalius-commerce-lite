import { describe, expect, it } from "vitest";
import {
  STOREFRONT_CARD_ACTIONS,
  STOREFRONT_CARD_FACTS,
  STOREFRONT_CARD_VARIANTS,
  storefrontBlockVariants,
  storefrontVariantSpec,
  type StorefrontCardRenderer,
} from "./blocks";
import { storefrontThemeDocumentSchema, STOREFRONT_TEMPLATE_IDS } from "./document";
import { EMPTY_STORE_SHAPE } from "./fit";
import { resolveStorefrontTheme } from "./resolve";
import { storefrontTemplateTheme } from "./templates";
import { STOREFRONT_IMAGE_RATIOS } from "./tokens";

const spec = storefrontVariantSpec("card", "standard");
const render = (settings: unknown) => (spec.renders as (settings: unknown) => StorefrontCardRenderer)(settings);
const accepts = (card: unknown) => {
  const theme = storefrontTemplateTheme("department-mall");
  return storefrontThemeDocumentSchema.safeParse({ ...theme, blocks: { ...theme.blocks, card } }).success;
};

describe("the one product card", () => {
  it("is the only card variant, with facts, action and hover image as its settings", () => {
    expect(storefrontBlockVariants("card")).toEqual(["standard"]);
    expect(Object.keys(STOREFRONT_CARD_VARIANTS)).toEqual(["standard"]);
    expect(spec.defaults).toEqual({ facts: "none", action: "none", hoverImage: false });
    expect([...STOREFRONT_CARD_FACTS]).toEqual(["none", "key-specs", "swatches", "delivery"]);
    expect([...STOREFRONT_CARD_ACTIONS]).toEqual(["none", "quick-add", "full"]);
  });

  it("accepts every facts, action and hover image combination, and renders it as stored", () => {
    for (const facts of STOREFRONT_CARD_FACTS) {
      for (const action of STOREFRONT_CARD_ACTIONS) {
        for (const hoverImage of [false, true]) {
          const settings = { facts, action, hoverImage };
          expect(accepts({ variant: "standard", settings }), JSON.stringify(settings)).toBe(true);
          expect(render(settings)).toEqual(settings);
        }
      }
    }
  });

  it("rejects unknown values, missing and extra keys, and other variants", () => {
    const ok = { facts: "none", action: "none", hoverImage: false };
    expect(accepts({ variant: "standard", settings: ok })).toBe(true);
    expect(accepts({ variant: "standard", settings: { ...ok, facts: "ratings" } })).toBe(false);
    expect(accepts({ variant: "standard", settings: { ...ok, action: "buy-now" } })).toBe(false);
    expect(accepts({ variant: "standard", settings: { ...ok, hoverImage: "yes" } })).toBe(false);
    expect(accepts({ variant: "standard", settings: { ...ok, quickAction: true } })).toBe(false);
    expect(accepts({ variant: "standard", settings: { facts: "none", action: "none" } })).toBe(false);
    expect(accepts({ variant: "standard", settings: ok, extra: 1 })).toBe(false);
    for (const retired of ["boutique", "mall", "retail", "detailed", "spec"]) {
      expect(accepts({ variant: retired, settings: ok }), retired).toBe(false);
    }
  });

  it("declares the sale colour on the card as the one contrast pair it paints", () => {
    expect(spec.contrastPairs.map((pair) => pair.join("/"))).toEqual(["destructive/card"]);
  });

  it.each(STOREFRONT_TEMPLATE_IDS)("the %s preset uses it, and the resolved card carries its settings and the theme's photo tokens", (id) => {
    const theme = storefrontTemplateTheme(id);
    expect(theme.blocks.card.variant).toBe("standard");
    const { productCard } = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout;
    expect(productCard).toEqual({
      ...theme.blocks.card.settings,
      imageRatio: theme.tokens.imageRatio,
      imageFit: theme.tokens.imageFit,
      surface: theme.tokens.surface,
    });
  });

  it.each(STOREFRONT_IMAGE_RATIOS)("follows the %s photo ratio, fit and surface tokens", (imageRatio) => {
    const theme = storefrontTemplateTheme("department-mall");
    theme.tokens.imageRatio = imageRatio;
    theme.tokens.imageFit = "contain";
    theme.tokens.surface = "raised";
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard).toMatchObject({ imageRatio, imageFit: "contain", surface: "raised" });
  });

  it("gives the presets their card settings", () => {
    const card = (id: (typeof STOREFRONT_TEMPLATE_IDS)[number]) => storefrontTemplateTheme(id).blocks.card.settings;
    expect(card("department-mall")).toEqual({ facts: "none", action: "full", hoverImage: false });
    expect(card("boutique")).toEqual({ facts: "swatches", action: "none", hoverImage: true });
    expect(card("marketplace")).toEqual({ facts: "delivery", action: "none", hoverImage: false });
    expect(card("daily-essentials")).toEqual({ facts: "none", action: "quick-add", hoverImage: false });
    expect(card("showcase-landing")).toEqual({ facts: "none", action: "full", hoverImage: false });
  });

  it("keeps a merchant's card settings through resolve", () => {
    const theme = storefrontTemplateTheme("showcase-landing");
    theme.blocks.card = { variant: "standard", settings: { facts: "key-specs", action: "quick-add", hoverImage: true } };
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard).toMatchObject({ facts: "key-specs", action: "quick-add", hoverImage: true });
  });
});
