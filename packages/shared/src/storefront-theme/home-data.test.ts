import { describe, expect, it } from "vitest";
import {
  HOME_BRAND_LIMIT,
  HOME_MAX_CATEGORIES,
  HOME_MAX_COLLECTIONS,
  HOME_MAX_MEDIA,
  HOME_MAX_PRODUCT_LISTS,
  HOME_PRODUCT_LIST_LIMIT,
  homeSectionRequests,
  homeSectionRequestsEmpty,
  homeSectionsShowDeliveryFacts,
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
      section({ id: "g", type: "hero", version: 1, settings: { layout: "contained-banners", slides: [
        { image: "s1", phoneImage: "s1p", focalPoint: { x: 50, y: 50 }, alt: "Eid", link: null },
        { image: "m2", focalPoint: { x: 50, y: 50 }, alt: "Sale", link: "/sale" },
      ], sideBanners: [{ mediaId: "m3", alt: "", href: null }] } }),
      section({ id: "h", type: "hero", version: 1, settings: { layout: "split", slides: [], sideBanners: [{ mediaId: "m4", alt: "", href: null }] } }),
      section({ id: "i", type: "collections", version: 1, settings: { carousel: "large", collectionIds: ["col_b", "col_a"] } }),
      section({ id: "i2", type: "collections", version: 1, settings: { carousel: "compact", collectionIds: ["col_a", "col_c"] } }),
      section({ id: "k", type: "category-tiles", version: 1, settings: { style: "photo", title: "", categoryIds: ["cat_2", "cat_1"] } }),
      section({ id: "j", type: "endless-grid", version: 1, settings: { title: "", pageSize: 36 } }),
    ]);
    expect(requests.lists).toEqual([
      { key: "newest", source: { kind: "newest" }, limit: 36 },
      { key: "on-sale", source: { kind: "on-sale" }, limit: 12 },
      { key: "popular", source: { kind: "popular" }, limit: 8 },
      { key: "category:cat", source: { kind: "category", categoryId: "cat" }, limit: 8 },
    ]);
    // Every slide's images (the phone image too); side banners only beside a contained hero.
    expect(requests.mediaIds).toEqual(["m5", "m6", "m1", "m2", "s1", "s1p", "m3"]);
    expect(requests.categoryIds).toEqual(["cat_2", "cat_1"]);
    expect(requests.collectionIds).toEqual(["col_b", "col_a", "col_c"]);
    expect(requests.brandLimit).toBe(HOME_BRAND_LIMIT);
    expect(requests.promotionIds).toEqual(["promo_a"]);
    expect(requests.homeProductId).toBeNull();
  });

  it("reads a product homepage's product, and the delivery facts only for a section that shows them", () => {
    const requests = homeSectionRequests([], { kind: "product", productId: "prod_1" });
    expect(requests.homeProductId).toBe("prod_1");
    expect(homeSectionRequestsEmpty(requests)).toBe(false);
    expect(homeSectionsShowDeliveryFacts([storefrontSectionDefault("usp-strip", "u")])).toBe(true);
    expect(homeSectionsShowDeliveryFacts([section({ id: "u", type: "usp-strip", version: 1, settings: { style: "icons", source: { kind: "custom", items: [{ title: "COD", detail: "" }] } } })])).toBe(false);
    expect(homeSectionsShowDeliveryFacts([section({ ...storefrontSectionDefault("hero", "h"), settings: { layout: "app-panel", slides: [] } })])).toBe(true);
    expect(homeSectionsShowDeliveryFacts([storefrontSectionDefault("hero", "h")])).toBe(false);
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
    // A hero without slides and category tiles without categories have nothing to show either.
    expect(needs.sort()).toEqual(["banner", "banner-mosaic", "category-tiles", "editorial", "faq", "hero", "seo-text", "shop-by", "utility-cards"]);
    expect(storefrontSectionNeedsContent(section({ id: "b", type: "banner", version: 1, settings: { layout: "full", heading: "Eid", text: "", mediaId: null, cta: null } }))).toBe(false);
  });

  it("bounds tabbed product blocks to 2 to 4 tabs", () => {
    const tabs = (count: number) => storefrontSectionListSchema.safeParse([{
      id: "t", type: "product-tabs", version: 1,
      settings: { title: "", limit: 8, tabs: Array.from({ length: count }, () => ({ label: "", source: { kind: "newest" } })) },
    }]).success;
    expect([1, 2, 4, 5].map(tabs)).toEqual([false, true, true, false]);
  });

  it("caps the lists, images, categories and collections one homepage reads", () => {
    const sections = Array.from({ length: 24 }, (_, index) =>
      section({ id: `s${index}`, type: "shop-by", version: 1, settings: { title: "", cards: Array.from({ length: 2 }, (_, card) => ({ mediaId: `m${index}-${card}`, title: "x", href: "/x" })) } }));
    const lookbooks = Array.from({ length: 12 }, (_, index) =>
      section({ id: `l${index}`, type: "lookbook", version: 1, settings: { title: "", mediaId: null, source: { kind: "category", categoryId: `c${index}` } } }));
    const tiles = Array.from({ length: 3 }, (_, index) =>
      section({ id: `t${index}`, type: "category-tiles", version: 1, settings: { style: "photo", title: "", categoryIds: Array.from({ length: 12 }, (_, id) => `cat${index}-${id}`) } }));
    const shelves = Array.from({ length: 2 }, (_, index) =>
      section({ id: `c${index}`, type: "collections", version: 1, settings: { carousel: "large", collectionIds: Array.from({ length: 8 }, (_, id) => `col${index}-${id}`) } }));
    const requests = homeSectionRequests([...sections, ...lookbooks, ...tiles, ...shelves]);
    expect(requests.lists).toHaveLength(HOME_MAX_PRODUCT_LISTS);
    expect(requests.mediaIds).toHaveLength(HOME_MAX_MEDIA);
    expect(requests.categoryIds).toHaveLength(HOME_MAX_CATEGORIES);
    expect(requests.collectionIds).toHaveLength(HOME_MAX_COLLECTIONS);
    expect(requests.lists.every((list) => list.limit <= HOME_PRODUCT_LIST_LIMIT)).toBe(true);
  });

  it("renders every registered section type", () => {
    const waiting = STOREFRONT_SECTION_TYPES.filter((type) => !(STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(type));
    expect(waiting).toEqual([]);
    for (const type of STOREFRONT_SECTION_TYPES) {
      expect(storefrontSectionRenderer(storefrontSectionDefault(type, "x"))).toBe(type);
    }
  });

  it("keeps stored newsletters valid and bounds the signup's own settings", () => {
    const parse = (settings: object) => storefrontSectionListSchema.safeParse([{ id: "n", type: "newsletter", version: 1, settings }]).success;
    // A version 1 newsletter saved before the form had its own settings.
    expect(parse({ heading: "Join", text: "" })).toBe(true);
    expect(parse({ heading: "", text: "", email: "required", whatsapp: true, buttonLabel: "Subscribe" })).toBe(true);
    expect(parse({ heading: "", text: "", email: "hidden" })).toBe(true);
    expect(parse({ heading: "", text: "", email: "never" })).toBe(false);
    expect(parse({ heading: "", text: "", buttonLabel: "x".repeat(41) })).toBe(false);
    expect(parse({ heading: "", text: "", phone: "hidden" })).toBe(false);
    expect(storefrontSectionNeedsContent(storefrontSectionDefault("newsletter", "n"))).toBe(false);
    for (const template of ["boutique"] as const) {
      expect(storefrontTemplateTheme(template).pages.home.at(-1)?.type, template).toBe("newsletter");
    }
  });

  it("keeps stored heroes without side banners valid, and bounds side banners", () => {
    for (const template of STOREFRONT_TEMPLATES) {
      expect(storefrontThemeDocumentSchema.safeParse(storefrontTemplateTheme(template.id)).success).toBe(true);
    }
    const hero = (settings: object) => storefrontSectionListSchema.safeParse([{ id: "hero", type: "hero", version: 1, settings: { slides: [], ...settings } }]).success;
    expect(hero({ layout: "contained-banners" })).toBe(true);
    expect(hero({ layout: "wide-editorial" })).toBe(true);
    expect(hero({ layout: "contained-banners", sideBanners: [{ mediaId: "m", alt: "Sale", href: "/sale" }] })).toBe(true);
    expect(hero({ layout: "contained-banners", sideBanners: [{ mediaId: "m", alt: "", href: "javascript:x" }] })).toBe(false);
    expect(hero({
      layout: "contained-banners",
      sideBanners: Array.from({ length: 3 }, () => ({ mediaId: "m", alt: "", href: null })),
    })).toBe(false);
  });

  it("validates hero slides: media ids, alt text, focal points, navigation-safe links and at most ten", () => {
    const slide = { image: "m1", focalPoint: { x: 20, y: 80 }, alt: "Eid collection", link: "/collections/eid" };
    const hero = (slides: object[]) => storefrontSectionListSchema.safeParse([{ id: "hero", type: "hero", version: 1, settings: { layout: "full-bleed", slides } }]).success;
    expect(hero([slide])).toBe(true);
    expect(hero([{ ...slide, phoneImage: "m2", phoneFocalPoint: { x: 50, y: 10 }, heading: "Eid", text: "New in", buttonLabel: "Shop" }])).toBe(true);
    expect(hero([{ ...slide, link: null }])).toBe(true);
    expect(hero([{ ...slide, link: "https://example.com/eid" }])).toBe(true);
    for (const link of ["javascript:alert(1)", "http://example.com", "//evil.example", "/a b", "shop", "https://user:pw@example.com/"]) {
      expect(hero([{ ...slide, link }]), link).toBe(false);
    }
    expect(hero([{ ...slide, alt: " " }])).toBe(false);
    expect(hero([{ ...slide, image: "" }])).toBe(false);
    expect(hero([{ ...slide, focalPoint: { x: 101, y: 0 } }])).toBe(false);
    expect(hero([{ ...slide, url: "https://cdn.example/x.jpg" }])).toBe(false);
    expect(hero(Array.from({ length: 10 }, () => slide))).toBe(true);
    expect(hero(Array.from({ length: 11 }, () => slide))).toBe(false);
  });

  it("keeps category and collection ids unique and bounded", () => {
    const parse = (type: string, settings: object) => storefrontSectionListSchema.safeParse([{ id: "x", type, version: 1, settings }]).success;
    expect(parse("category-tiles", { style: "round", title: "Shop", categoryIds: ["a", "b"] })).toBe(true);
    expect(parse("category-tiles", { style: "round", title: "", categoryIds: ["a", "a"] })).toBe(false);
    expect(parse("category-tiles", { style: "round", title: "", categoryIds: Array.from({ length: 13 }, (_, i) => `c${i}`) })).toBe(false);
    expect(parse("collections", { carousel: "large", collectionIds: ["a", "b"] })).toBe(true);
    expect(parse("collections", { carousel: "large", collectionIds: ["a", "a"] })).toBe(false);
    expect(parse("collections", { carousel: "large", collectionIds: Array.from({ length: 9 }, (_, i) => `c${i}`) })).toBe(false);
  });
});
