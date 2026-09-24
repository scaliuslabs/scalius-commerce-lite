import { describe, expect, it } from "vitest";
import {
  HOME_MAX_MEDIA,
  HOME_MAX_PRODUCT_LISTS,
  HOME_PRODUCT_LIST_LIMIT,
  homeSectionRequestParams,
  homeSectionRequests,
  parseHomeSectionRequestParams,
  parseStorefrontProductSourceKey,
  storefrontProductSourceKey,
} from "./home-data";
import {
  STOREFRONT_SECTION_RENDERERS,
  STOREFRONT_SECTION_TYPES,
  storefrontSectionDefault,
  storefrontSectionListSchema,
  storefrontSectionRenderer,
  type StorefrontSection,
} from "./sections";
import { STOREFRONT_TEMPLATES, storefrontTemplateTheme } from "./templates";
import { storefrontThemeDocumentSchema } from "./document";

const section = (value: object) => value as StorefrontSection;

describe("homepage section data requests", () => {
  it("keys every product source and reads each key back", () => {
    const sources = [
      { kind: "newest" },
      { kind: "on-sale" },
      { kind: "popular" },
      { kind: "collection", collectionId: "col_a:b" },
      { kind: "category", categoryId: "cat_1" },
    ] as const;
    for (const source of sources) {
      expect(parseStorefrontProductSourceKey(storefrontProductSourceKey(source))).toEqual(source);
    }
    expect(parseStorefrontProductSourceKey("brand:x")).toBeNull();
    expect(parseStorefrontProductSourceKey("category:")).toBeNull();
    expect(parseStorefrontProductSourceKey("category:has space")).toBeNull();
  });

  it("reads each source once at the largest limit, and each image once", () => {
    const requests = homeSectionRequests([
      section({ id: "a", type: "product-rail", version: 1, settings: { title: "", source: { kind: "newest" }, limit: 8 } }),
      section({ id: "b", type: "product-grid", version: 1, settings: { title: "", source: { kind: "newest" }, columns: 6, rows: 4 } }),
      section({ id: "c", type: "deal-block", version: 1, settings: { title: "", source: { kind: "on-sale" }, endsAt: null } }),
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
      { key: "category:cat", source: { kind: "category", categoryId: "cat" }, limit: 8 },
    ]);
    // Side banners only show beside a contained hero.
    expect(requests.mediaIds).toEqual(["m1", "m2", "m3"]);
  });

  it("caps the lists and images one homepage reads", () => {
    const sections = Array.from({ length: 24 }, (_, index) =>
      section({ id: `s${index}`, type: "lookbook", version: 1, settings: { title: "", mediaId: `m${index}`, source: { kind: "category", categoryId: `c${index}` } } }));
    const requests = homeSectionRequests(sections);
    expect(requests.lists).toHaveLength(HOME_MAX_PRODUCT_LISTS);
    expect(requests.mediaIds).toHaveLength(HOME_MAX_MEDIA);
    expect(requests.lists.every((list) => list.limit <= HOME_PRODUCT_LIST_LIMIT)).toBe(true);
  });

  it("round-trips requests through the homepage query", () => {
    const requests = homeSectionRequests(storefrontTemplateTheme("fashion-value").pages.home);
    const params = homeSectionRequestParams(requests);
    const parsed = parseHomeSectionRequestParams(
      params.filter(([name]) => name === "product").map(([, value]) => value),
      params.filter(([name]) => name === "media").map(([, value]) => value),
    );
    expect(parsed?.lists.map((list) => [list.key, list.limit]).sort())
      .toEqual(requests.lists.map((list) => [list.key, list.limit]).sort());
    expect(parseHomeSectionRequestParams(["37~newest"], [])).toBeNull();
    expect(parseHomeSectionRequestParams(["0~newest"], [])).toBeNull();
    expect(parseHomeSectionRequestParams(["8~brand:x"], [])).toBeNull();
    expect(parseHomeSectionRequestParams([], ["bad id"])).toBeNull();
    expect(parseHomeSectionRequestParams(Array.from({ length: 9 }, (_, index) => `8~category:c${index}`), [])).toBeNull();
    // Equal requests give equal queries (one cache entry).
    expect(homeSectionRequestParams({ lists: [...requests.lists].reverse(), mediaIds: [] }))
      .toEqual(homeSectionRequestParams({ lists: requests.lists, mediaIds: [] }));
  });

  it("renders every section type whose data exists today", () => {
    const waiting = STOREFRONT_SECTION_TYPES.filter((type) => !(STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(type));
    expect(waiting.sort()).toEqual(["brand-wall", "newsletter", "recently-viewed"]);
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
