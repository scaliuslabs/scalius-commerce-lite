import { describe, expect, it } from "vitest";
import type { StorefrontImage, StorefrontProductList, StorefrontTile } from "../plugins/storefront-protocol";
import { storefrontThemeDocumentSchema } from "./document";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { storefrontSectionDefault, storefrontVisibleSection, type StorefrontSectionOf } from "./sections";
import {
  STOREFRONT_SKINNABLE_SECTION_TYPES,
  isStorefrontSkinTarget,
  resolveCoreSectionSettings,
  storefrontSectionSkinTarget,
  storefrontSkinTargetSection,
  type CoreSectionResolver,
  type CoreSectionSettings,
} from "./skins";

const image = (id: string): StorefrontImage => ({ url: `https://media.example.com/${id}.webp`, srcset: null, width: 1200, height: 800, alt: id });
const tile = (kind: string, id: string): StorefrontTile => ({ id, title: `${kind} ${id}`, url: `/${kind}/${id}`, image: null, cards: [] });

const resolver: CoreSectionResolver = {
  image: (id) => (id === "gone" ? null : image(id)),
  products: (source): StorefrontProductList => ({ title: source.kind, url: "/search", cards: [] }),
  tiles: (kind, ids) => ids.filter((id) => id !== "gone").map((id) => tile(kind, id)),
  promotion: (id) => (id === "promo_live" ? { endsAt: "2026-12-01T00:00:00.000Z" } : null),
  deliveryFacts: () => [{ title: "Free delivery", detail: "Over ৳2,000" }],
};

describe("skin targets", () => {
  it("names the fixed units and the skinnable core sections", () => {
    expect(isStorefrontSkinTarget("header")).toBe(true);
    expect(isStorefrontSkinTarget("listing-main")).toBe(true);
    expect(isStorefrontSkinTarget("section:hero")).toBe(true);
    expect(isStorefrontSkinTarget(storefrontSectionSkinTarget("faq"))).toBe(true);
    // The buyer's history, an endless feed and content types have no projection.
    for (const type of ["recently-viewed", "endless-grid", "metaobjects", "app", "nope"]) {
      expect(isStorefrontSkinTarget(`section:${type}`)).toBe(false);
    }
    expect(isStorefrontSkinTarget("sidebar")).toBe(false);
    expect(storefrontSkinTargetSection("section:deal-block")).toBe("deal-block");
    expect(storefrontSkinTargetSection("header")).toBeNull();
    expect(STOREFRONT_SKINNABLE_SECTION_TYPES).toContain("newsletter");
  });

  it("keeps skins in the document: the units under apps.skins, a core section's on its placement", () => {
    const hero = { ...storefrontSectionDefault("hero", "hero"), skin: { app: "acme.theme/hero", values: { scrim: 40 } } };
    const document = {
      ...DEFAULT_STOREFRONT_THEME,
      apps: { skins: { "product-main": { app: "acme.theme/pdp", values: { gallery: "stack" } } } },
      pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: [hero] },
    };
    expect(storefrontThemeDocumentSchema.safeParse(document).success).toBe(true);
    // The old slot keys are gone: such a stored row no longer parses (reset by a data migration).
    expect(storefrontThemeDocumentSchema.safeParse({ ...DEFAULT_STOREFRONT_THEME, apps: { header: { app: "acme.theme/head", values: {} } } }).success).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse({ ...document, apps: { skins: { sidebar: { app: "acme.theme/x", values: {} } } } }).success).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse({ ...document, apps: { skins: { header: { app: "not a key", values: {} } } } }).success).toBe(false);
  });
});

describe("a core section's projection", () => {
  it("resolves media, product sources, tiles, promotions and delivery facts by fixed rules", () => {
    const hero: StorefrontSectionOf<"hero"> = {
      ...storefrontSectionDefault("hero", "hero"),
      settings: {
        layout: "contained-banners",
        slides: [
          { image: "m1", phoneImage: "m2", focalPoint: { x: 50, y: 50 }, alt: "One", link: "/sale" },
          { image: "gone", focalPoint: { x: 50, y: 50 }, alt: "Two", link: null, hidden: true },
        ],
        sideBanners: [{ mediaId: "m3", alt: "Side", href: "/new" }],
      },
    };
    const settings: CoreSectionSettings<"hero"> = resolveCoreSectionSettings(storefrontVisibleSection(hero), resolver);
    expect(settings.slides).toHaveLength(1);
    expect(settings.slides[0]!.image).toEqual(image("m1"));
    expect(settings.slides[0]!.phoneImage).toEqual(image("m2"));
    expect(settings.slides[0]!.link).toBe("/sale");
    expect(settings.sideBanners?.[0]?.mediaId).toEqual(image("m3"));

    const deal: StorefrontSectionOf<"deal-block"> = {
      ...storefrontSectionDefault("deal-block", "deal"),
      settings: { ...storefrontSectionDefault("deal-block", "deal").settings, source: { kind: "category", categoryId: "cat_1" }, promotionId: "promo_live" },
    };
    const dealSettings = resolveCoreSectionSettings(deal, resolver);
    expect(dealSettings.source).toEqual({ title: "category", url: "/search", cards: [] });
    expect(dealSettings.promotionId).toEqual({ endsAt: "2026-12-01T00:00:00.000Z" });

    const tiles: StorefrontSectionOf<"category-tiles"> = {
      ...storefrontSectionDefault("category-tiles", "tiles"),
      settings: { ...storefrontSectionDefault("category-tiles", "tiles").settings, categoryIds: ["cat_1", "gone", "cat_2"] },
    };
    expect(resolveCoreSectionSettings(tiles, resolver).categoryIds.map((each) => each.id)).toEqual(["cat_1", "cat_2"]);

    const strip = storefrontSectionDefault("usp-strip", "usp");
    expect(resolveCoreSectionSettings(strip, resolver).source).toEqual({ kind: "delivery-facts", items: [{ title: "Free delivery", detail: "Over ৳2,000" }] });
    const custom: StorefrontSectionOf<"usp-strip"> = { ...strip, settings: { style: "icons", source: { kind: "custom", items: [{ title: "Gift wrap", detail: "Free" }] } } };
    expect(resolveCoreSectionSettings(custom, resolver).source).toEqual({ kind: "custom", items: [{ title: "Gift wrap", detail: "Free" }] });
  });
});
