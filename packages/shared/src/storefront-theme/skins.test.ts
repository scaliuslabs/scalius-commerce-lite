import { describe, expect, it } from "vitest";
import { STOREFRONT_SECTION_SKIN_PROJECTIONS, type StorefrontHeroSkinSettings, type StorefrontImage, type StorefrontProductList, type StorefrontTile } from "../plugins/storefront-protocol";
import { storefrontThemeDocumentSchema } from "./document";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { STOREFRONT_SECTION_RENDERERS, storefrontSectionDefault, storefrontVisibleSection, type StorefrontSectionOf } from "./sections";
import {
  STOREFRONT_SKINNABLE_SECTION_TYPES,
  isStorefrontSkinTarget,
  coreSectionSkinSettings,
  storefrontSectionSkinTarget,
  storefrontSkinTargetSection,
  type CoreSectionResolver,

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
    expect(isStorefrontSkinTarget("listing_main")).toBe(true);
    expect(isStorefrontSkinTarget("section:hero")).toBe(true);
    expect(isStorefrontSkinTarget(storefrontSectionSkinTarget("faq"))).toBe(true);
    // The buyer's history, an endless feed and content types have no projection.
    for (const type of ["recently_viewed", "endless_grid", "objects", "app", "nope"]) {
      expect(isStorefrontSkinTarget(`section:${type}`)).toBe(false);
    }
    expect(isStorefrontSkinTarget("sidebar")).toBe(false);
    expect(storefrontSkinTargetSection("section:deal_block")).toBe("deal_block");
    expect(storefrontSkinTargetSection("header")).toBeNull();
    expect(STOREFRONT_SKINNABLE_SECTION_TYPES).toContain("newsletter");
  });

  it("keeps skins in the document: the units under apps.skins, a core section's on its placement", () => {
    const hero = { ...storefrontSectionDefault("hero", "hero"), skin: { app: "acme.theme/hero", values: { scrim: 40 } } };
    const document = {
      ...DEFAULT_STOREFRONT_THEME,
      apps: { skins: { "product_main": { app: "acme.theme/pdp", values: { gallery: "stack" } } } },
      pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: [hero] },
    };
    expect(storefrontThemeDocumentSchema.safeParse(document).success).toBe(true);
    // The old slot keys are gone: a document with them does not parse.
    expect(storefrontThemeDocumentSchema.safeParse({ ...DEFAULT_STOREFRONT_THEME, apps: { header: { app: "acme.theme/head", values: {} } } }).success).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse({ ...document, apps: { skins: { sidebar: { app: "acme.theme/x", values: {} } } } }).success).toBe(false);
    expect(storefrontThemeDocumentSchema.safeParse({ ...document, apps: { skins: { header: { app: "not a key", values: {} } } } }).success).toBe(false);
  });
});

describe("a core section's projection", () => {
  it("is sealed per type in the protocol, versioned on its own", () => {
    expect(STOREFRONT_SKINNABLE_SECTION_TYPES).toEqual(Object.keys(STOREFRONT_SECTION_SKIN_PROJECTIONS));
    expect(STOREFRONT_SKINNABLE_SECTION_TYPES.filter((type) => !STOREFRONT_SECTION_RENDERERS.includes(type))).toEqual([]);
    expect(STOREFRONT_SECTION_RENDERERS.filter((type) => !(STOREFRONT_SKINNABLE_SECTION_TYPES as string[]).includes(type)))
      .toEqual(["endless_grid", "recently_viewed", "objects"]);
  });

  it("leaves out what only the editor reads: hidden marks and dynamic sources", () => {
    const faq: StorefrontSectionOf<"faq"> = {
      ...storefrontSectionDefault("faq", "faq"),
      bindings: { heading: { source: "resource.title" } },
      settings: { heading: "Questions", items: [{ question: "Cash on delivery?", answer: "Yes", bindings: { answer: { source: "resource.description" } } }] },
    };
    expect(coreSectionSkinSettings(storefrontVisibleSection(faq), resolver)).toEqual({ heading: "Questions", items: [{ question: "Cash on delivery?", answer: "Yes" }] });
  });

  it("resolves a qualified Specifications object field without changing its literal fallback", () => {
    const section = storefrontSectionDefault("specifications", "size-chart");
    section.settings.objectField = "custom.size_chart";
    section.settings.rows = [{ label: "Fit", value: "Ask us" }];
    const fields = [{ key: "chest", name: "Chest", list: false, parts: [{ kind: "text" as const, text: "38 inches" }] }];
    expect(coreSectionSkinSettings(section, { ...resolver, objectField: (key) => key === "custom.size_chart" ? fields : [] }))
      .toMatchObject({ objectFields: fields, rows: section.settings.rows });
    expect(coreSectionSkinSettings(section, resolver).objectFields).toEqual([]);
  });

  it("resolves restored section images and preserves a tile's subtitle", () => {
    const deal = storefrontSectionDefault("deal_block", "sale");
    deal.settings.mediaId = "sale-photo";
    expect(coreSectionSkinSettings(deal, resolver).image).toEqual(image("sale-photo"));
    const newsletter = storefrontSectionDefault("newsletter", "newsletter");
    newsletter.settings.mediaId = "signup-photo";
    expect(coreSectionSkinSettings(newsletter, resolver).image).toEqual(image("signup-photo"));
    newsletter.settings.mediaId = "gone";
    expect(coreSectionSkinSettings(newsletter, resolver).image).toBeNull();
    const cards = storefrontSectionDefault("shop_by", "cards");
    cards.settings.cards = [{ mediaId: "tile", title: "Linen", subtitle: "Made for summer", href: "/linen" }];
    expect(coreSectionSkinSettings(cards, resolver).cards[0]).toEqual({ subtitle: "Made for summer", image: image("tile"), title: "Linen", href: "/linen" });
  });

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
    const settings: StorefrontHeroSkinSettings = coreSectionSkinSettings(storefrontVisibleSection(hero), resolver);
    expect(settings.slides).toHaveLength(1);
    expect(settings.slides[0]!.image).toEqual(image("m1"));
    expect(settings.slides[0]!.phoneImage).toEqual(image("m2"));
    expect(settings.slides[0]!.link).toBe("/sale");
    expect(settings.sideBanners).toEqual([{ image: image("m3"), alt: "Side", href: "/new" }]);

    const deal: StorefrontSectionOf<"deal_block"> = {
      ...storefrontSectionDefault("deal_block", "deal"),
      settings: { ...storefrontSectionDefault("deal_block", "deal").settings, source: { kind: "category", categoryId: "cat_1" }, promotionId: "promo_live" },
    };
    const dealSettings = coreSectionSkinSettings(deal, resolver);
    expect(dealSettings.products).toEqual({ title: "category", url: "/search", cards: [] });
    expect(dealSettings.promotion).toEqual({ endsAt: "2026-12-01T00:00:00.000Z" });

    const tiles: StorefrontSectionOf<"category_tiles"> = {
      ...storefrontSectionDefault("category_tiles", "tiles"),
      settings: { ...storefrontSectionDefault("category_tiles", "tiles").settings, categoryIds: ["cat_1", "gone", "cat_2"] },
    };
    expect(coreSectionSkinSettings(tiles, resolver).categories.map((each) => each.id)).toEqual(["cat_1", "cat_2"]);

    const strip = storefrontSectionDefault("usp_strip", "usp");
    expect(coreSectionSkinSettings(strip, resolver).source).toEqual({ kind: "delivery-facts", items: [{ title: "Free delivery", detail: "Over ৳2,000" }] });
    const custom: StorefrontSectionOf<"usp_strip"> = { ...strip, settings: { style: "icons", source: { kind: "custom", items: [{ title: "Gift wrap", detail: "Free" }] } } };
    expect(coreSectionSkinSettings(custom, resolver).source).toEqual({ kind: "custom", items: [{ title: "Gift wrap", detail: "Free" }] });
  });
});
