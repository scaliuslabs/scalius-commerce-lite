import { describe, expect, it } from "vitest";
import {
  HOME_BRAND_LIMIT,
  HOME_MAX_MEDIA,
  HOME_MAX_PRODUCT_LISTS,
  HOME_PRODUCT_LIST_LIMIT,
  homeSectionRequests,
  homeSectionRequestsEmpty,
  storefrontProductSourceKey,
} from "./home-data";
import {
  STOREFRONT_SECTION_RENDERERS,
  STOREFRONT_SECTION_TYPES,
  storefrontSectionDefault,
  storefrontSectionListSchema,
  storefrontSectionNeedsContent,
  storefrontSectionRenderer,
  type StorefrontSection,
} from "./sections";
import { STOREFRONT_TEMPLATES, storefrontTemplateTheme } from "./templates";
import { storefrontThemeDocumentSchema } from "./document";

const section = (value: object) => value as StorefrontSection;

describe("homepage section data requests", () => {
  it("keys every product source", () => {
    expect([
      { kind: "newest" },
      { kind: "on-sale" },
      { kind: "popular" },
      { kind: "collection", collectionId: "col_a" },
      { kind: "category", categoryId: "cat_1" },
    ].map((source) => storefrontProductSourceKey(source as never)))
      .toEqual(["newest", "on-sale", "popular", "collection:col_a", "category:cat_1"]);
  });

  it("reads each source once at the largest limit, and each image once", () => {
    const requests = homeSectionRequests([
      section({ id: "a", type: "product-rail", version: 1, settings: { title: "", source: { kind: "newest" }, limit: 8 } }),
      section({ id: "b", type: "product-grid", version: 1, settings: { title: "", source: { kind: "newest" }, columns: 6, rows: 4 } }),
      section({ id: "c", type: "deal-block", version: 1, settings: { title: "", source: { kind: "on-sale" }, promotionId: "promo_a" } }),
      section({ id: "c2", type: "product-tabs", version: 1, settings: { title: "", limit: 8, tabs: [
        { label: "", source: { kind: "on-sale" } },
        { label: "Top", source: { kind: "popular" } },
      ] } }),
      section({ id: "c3", type: "shop-by", version: 1, settings: { title: "", cards: [{ mediaId: "m5", title: "Eid", href: "/eid" }] } }),
      section({ id: "c4", type: "banner-mosaic", version: 1, settings: { tiles: [{ mediaId: "m6", alt: "", href: null }, { mediaId: "m1", alt: "", href: null }] } }),
      section({ id: "c5", type: "brand-wall", version: 1, settings: { title: "", style: "rail" } }),
      section({ id: "d", type: "lookbook", version: 1, settings: { title: "", mediaId: "m1", source: { kind: "category", categoryId: "cat" } } }),
      section({ id: "e", type: "banner", version: 1, settings: { layout: "two-up", heading: "", text: "", mediaId: "m1", cta: null } }),
      section({ id: "f", type: "editorial", version: 1, settings: { layout: "image-with-text", heading: "", body: "", mediaId: "m2", imageSide: "end" } }),
      section({ id: "g", type: "hero", version: 1, settings: { layout: "contained-banners", sideBanners: [{ mediaId: "m3", alt: "", href: null }] } }),
      section({ id: "h", type: "hero", version: 1, settings: { layout: "split", sideBanners: [{ mediaId: "m4", alt: "", href: null }] } }),
      section({ id: "i", type: "collections", version: 1, settings: {} }),
      section({ id: "j", type: "endless-grid", version: 1, settings: { title: "", pageSize: 36 } }),
    ]);
    expect(requests.lists).toEqual([
      { key: "newest", source: { kind: "newest" }, limit: 36 },
      { key: "on-sale", source: { kind: "on-sale" }, limit: 12 },
      { key: "popular", source: { kind: "popular" }, limit: 8 },
      { key: "category:cat", source: { kind: "category", categoryId: "cat" }, limit: 8 },
    ]);
    // Side banners only show beside a contained hero.
    expect(requests.mediaIds).toEqual(["m5", "m6", "m1", "m2", "m3"]);
    expect(requests.brandLimit).toBe(HOME_BRAND_LIMIT);
    expect(requests.promotionIds).toEqual(["promo_a"]);
  });

  it("reads no brands or promotions for a homepage without a brand wall or a promotion deal", () => {
    const requests = homeSectionRequests([
      section({ id: "c", type: "deal-block", version: 1, settings: { title: "", source: { kind: "on-sale" }, promotionId: null } }),
    ]);
    expect(requests.brandLimit).toBe(0);
    expect(requests.promotionIds).toEqual([]);
    expect(homeSectionRequestsEmpty(homeSectionRequests([storefrontSectionDefault("faq", "f")]))).toBe(true);
  });

  it("flags sections whose own words or photos are missing, never data-driven ones", () => {
    const needs = STOREFRONT_SECTION_TYPES.filter((type) => storefrontSectionNeedsContent(storefrontSectionDefault(type, "x")));
    expect(needs.sort()).toEqual(["banner", "banner-mosaic", "editorial", "faq", "seo-text", "shop-by", "utility-cards"]);
    expect(storefrontSectionNeedsContent(section({ id: "b", type: "banner", version: 1, settings: { layout: "full", heading: "Eid", text: "", mediaId: null, cta: null } }))).toBe(false);
  });

  it("bounds tabbed product blocks to 2 to 4 tabs", () => {
    const tabs = (count: number) => storefrontSectionListSchema.safeParse([{
      id: "t", type: "product-tabs", version: 1,
      settings: { title: "", limit: 8, tabs: Array.from({ length: count }, () => ({ label: "", source: { kind: "newest" } })) },
    }]).success;
    expect([1, 2, 4, 5].map(tabs)).toEqual([false, true, true, false]);
  });

  it("caps the lists and images one homepage reads", () => {
    const sections = Array.from({ length: 24 }, (_, index) =>
      section({ id: `s${index}`, type: "lookbook", version: 1, settings: { title: "", mediaId: `m${index}`, source: { kind: "category", categoryId: `c${index}` } } }));
    const requests = homeSectionRequests(sections);
    expect(requests.lists).toHaveLength(HOME_MAX_PRODUCT_LISTS);
    expect(requests.mediaIds).toHaveLength(HOME_MAX_MEDIA);
    expect(requests.lists.every((list) => list.limit <= HOME_PRODUCT_LIST_LIMIT)).toBe(true);
  });

  it("renders every section type whose data exists today", () => {
    const waiting = STOREFRONT_SECTION_TYPES.filter((type) => !(STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(type));
    expect(waiting.sort()).toEqual(["newsletter"]);
    for (const type of STOREFRONT_SECTION_TYPES) {
      const expected = waiting.includes(type) ? null : type;
      expect(storefrontSectionRenderer(storefrontSectionDefault(type, "x"))).toBe(expected);
    }
  });

  it("keeps stored heroes without side banners valid, and bounds side banners", () => {
    for (const template of STOREFRONT_TEMPLATES) {
      expect(storefrontThemeDocumentSchema.safeParse(storefrontTemplateTheme(template.id)).success).toBe(true);
    }
    const hero = (settings: object) => storefrontSectionListSchema.safeParse([{ id: "hero", type: "hero", version: 1, settings }]).success;
    expect(hero({ layout: "contained-banners" })).toBe(true);
    expect(hero({ layout: "contained-banners", sideBanners: [{ mediaId: "m", alt: "Sale", href: "/sale" }] })).toBe(true);
    expect(hero({ layout: "contained-banners", sideBanners: [{ mediaId: "m", alt: "", href: "javascript:x" }] })).toBe(false);
    expect(hero({
      layout: "contained-banners",
      sideBanners: Array.from({ length: 3 }, () => ({ mediaId: "m", alt: "", href: null })),
    })).toBe(false);
  });
});
