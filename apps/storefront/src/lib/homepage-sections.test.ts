import { describe, expect, it } from "vitest";
import { storefrontSectionDefault, type StorefrontSection, type StorefrontSectionType } from "@scalius/shared/storefront-theme";
import {
  dealEndsAt,
  homepageCategoryTiles,
  homepageCategoryTilesTitle,
  homepageCollections,
  homepageCollectionsFallback,
  homepageContent,
  homepageEmptyState,
  homepageLeadSection,
  homepageLead,
  homepagePhoneSections,
  homepageRenderUnits,
  homepageSectionProducts,
  homepageSectionRenders,
  seoTextBlocks,
  type HomepageContent,
} from "./homepage-sections";

const product = (id: string) => ({ id, name: id, slug: id }) as never;
const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

const category = (id: string, imageUrl: string | null = null) =>
  ({ id, name: `Category ${id}`, slug: `category-${id}`, description: null, imageUrl, canonicalPath: null });
const collection = (id: string, presentation: "grid" | "carousel", products: unknown[]) =>
  ({ id, name: `Collection ${id}`, presentation, config: {}, products, featuredProduct: null }) as never;

function content(overrides: Partial<HomepageContent> = {}): HomepageContent {
  return {
    ...homepageContent({
      lists: [
        { key: "newest", products: Array.from({ length: 12 }, (_, index) => product(`n${index}`)), category: null, collection: null },
        { key: "popular", products: [product("hit")], category: null, collection: null },
        { key: "category:cat", products: [product("c1")], category: { id: "cat", name: "Tea", slug: "tea", canonicalPath: "/categories/green-tea" }, collection: null },
        { key: "category:gone", products: [product("x")], category: null, collection: null },
        { key: "collection:col", products: [product("k1")], category: null, collection: { id: "col", title: "Eid edit" } },
      ] as never,
      media: [{ id: "m1", url: "https://cdn.test/m1.jpg", alt: "Eid", width: 10, height: 10 }],
      categories: [category("c1", "https://cdn.test/c1.jpg"), category("c2"), category("c3")],
      collections: [
        collection("col-grid", "grid", [product("g1")]),
        collection("col-rail", "carousel", [product("r1")]),
        collection("col-empty", "carousel", []),
      ],
    }, []),
    ...overrides,
  };
}

describe("homepage section products", () => {
  it("titles lists by what they are unless the merchant named them, and links the whole list", () => {
    expect(homepageSectionProducts(section("product_rail", "a", { title: "", source: { kind: "newest" }, limit: 4 }), content()))
      .toMatchObject({ title: "New arrivals", href: "/search", products: { length: 4 } });
    expect(homepageSectionProducts(section("product_rail", "a", { title: "  Fresh  ", source: { kind: "newest" }, limit: 4 }), content())?.title)
      .toBe("Fresh");
    expect(homepageSectionProducts(section("product_grid", "b", { title: "", source: { kind: "category", categoryId: "cat" }, columns: 2, rows: 1 }), content()))
      .toMatchObject({ title: "Tea", href: "/categories/green-tea" });
    expect(homepageSectionProducts(section("product_rail", "c", { title: "", source: { kind: "collection", collectionId: "col" }, limit: 4 }), content()))
      .toMatchObject({ title: "Eid edit", href: "/collections/col" });
    // Popular has no listing to link to.
    expect(homepageSectionProducts(section("product_rail", "d", { title: "", source: { kind: "popular" }, limit: 4 }), content())?.href).toBeNull();
    // Products of a category that is no longer public never show under a made-up title.
    expect(homepageSectionProducts(section("product_rail", "e", { title: "Tea", source: { kind: "category", categoryId: "gone" }, limit: 4 }), content())).toBeNull();
    // A source the read did not return renders nothing.
    expect(homepageSectionProducts(section("deal_block", "f", { title: "", source: { kind: "on-sale" } }), content())).toBeNull();
  });

  it("shows a collections section's own collections in its order, and the newest products without one that shows products", () => {
    const named = section("collections", "c", { collectionIds: ["col-rail", "gone", "col-empty", "col-grid"] }) as never;
    expect(homepageCollections(named, content()).map((each) => each.id)).toEqual(["col-rail", "col-grid"]);
    expect(homepageCollectionsFallback(named, content())).toEqual([]);
    const empty = section("collections", "c", { collectionIds: ["col-empty", "gone"] }) as never;
    expect(homepageCollections(empty, content())).toEqual([]);
    expect(homepageCollectionsFallback(empty, content())).toHaveLength(8);
    expect(homepageCollectionsFallback(section("collections", "c") as never, content())).toHaveLength(8);
    expect(homepageSectionRenders(empty, content({ lists: new Map() }))).toBe(false);
  });

  it("shows a category-tiles section's own categories in its order under its title", () => {
    const tiles = section("category_tiles", "t", { style: "round", title: "  ", categoryIds: ["c3", "gone", "c1"] }) as never;
    expect(homepageCategoryTiles(tiles, content()).map((each) => each.id)).toEqual(["c3", "c1"]);
    expect(homepageCategoryTilesTitle(tiles)).toBe("Shop by category");
    expect(homepageCategoryTilesTitle(section("category_tiles", "t", { title: " Departments " }) as never)).toBe("Departments");
    expect(homepageSectionRenders(tiles, content())).toBe(true);
    // The denser styles need two public categories; the photo rail needs one.
    expect(homepageSectionRenders(section("category_tiles", "t", { style: "round", categoryIds: ["c1", "gone"] }), content())).toBe(false);
    expect(homepageSectionRenders(section("category_tiles", "t", { style: "photo", categoryIds: ["c1", "gone"] }), content())).toBe(true);
  });
});

describe("homepage section rules", () => {
  it("says a new store has no products instead of a blank homepage, and points at the catalog when sections are hidden", () => {
    const sections = [section("collections", "c"), section("hero", "empty")];
    const emptyLists = homepageContent({
      lists: [{ key: "newest", products: [], category: null, collection: null }] as never,
      media: [], categories: [], collections: [],
    } as never, []);
    expect(homepageEmptyState(sections, emptyLists)).toBe("no-products");
    // Nothing read: the catalog may still hold products.
    expect(homepageEmptyState(sections, content({ lists: new Map(), collections: new Map() }))).toBe("browse");
    expect(homepageEmptyState([{ ...section("collections", "c"), hidden: true }], content())).toBe("browse");
    expect(homepageEmptyState(sections, content())).toBeNull();
  });

  it("reports the actual lead including text and banner rows, skipping hidden or empty sections", () => {
    const text = section("seo_text", "intro", { heading: "Welcome", body: "Shop here" });
    const hidden = { ...section("banner", "hidden", { heading: "Hidden" }), hidden: true };
    const missing = section("hero", "empty");
    const sections = [hidden, missing, text, section("banner", "photo", { mediaId: "m1" })];
    expect(homepageLead(sections, sections, content())).toEqual({ kind: "core", type: "seo_text" });
    const banners = [section("banner", "a", { layout: "two-up", heading: "A" }), section("banner", "b", { layout: "two-up", heading: "B" })];
    expect(homepageLead(banners, banners, content())).toEqual({ kind: "core", type: "banner" });
    expect(homepageLead([], [], content())).toBeNull();
  });

  it("shares an app lead's values and media without its product lists", () => {
    const app: StorefrontSection = { id: "lead", type: "app", version: 1, settings: { app: "acme.theme/hero", values: {} } };
    const component = { pluginId: "acme.theme", type: "hero", values: { image: "m1" }, media: [{ id: "m1", url: "https://cdn.test/hero.jpg", alt: "Hero", width: 100, height: 80 }], lists: [{ source: "newest", products: [product("p")] }] };
    const shown = content({ apps: new Map([[app.id, { sectionId: app.id, html: "", head: { meta: [], jsonLd: [] }, component }]]) });
    expect(homepageLead([app], [app], shown)).toEqual({ kind: "app", pluginId: component.pluginId, type: "hero", instanceId: app.id, values: component.values, media: component.media });
  });

  it("moves a visible banner after category tiles only for phones when the merchant chooses it", () => {
    const slides = [{ image: "m1", focalPoint: { x: 50, y: 50 }, alt: "Eid", link: null }];
    const hero = section("hero", "hero", { phonePlacement: "after-categories", slides });
    const categories = section("category_tiles", "tiles", { style: "photo", categoryIds: ["c1"] });
    const sections = [hero, section("usp_strip", "notice"), categories];
    const shown = content();
    expect(homepagePhoneSections(sections, shown).map((each) => each.id)).toEqual(["notice", "tiles", "hero"]);
    expect(homepageLead(sections, homepagePhoneSections(sections, shown), shown)).toBeNull();
    expect(homepageLeadSection(homepagePhoneSections(sections, shown), shown, true)?.id).toBe("tiles");
    // Without a resolvable slide the hero shows nothing, so nothing moves.
    expect(homepagePhoneSections(sections, content({ media: new Map() }))).toBe(sections);
    expect(homepagePhoneSections([categories, hero], shown)).toEqual([categories, hero]);
  });

  it("renders a section only with data", () => {
    const empty = content({ lists: new Map(), media: new Map() });
    expect(homepageSectionRenders(section("hero", "h"), empty)).toBe(false);
    // A hero renders while one of its slides' images resolves.
    const slides = [{ image: "gone", focalPoint: { x: 50, y: 50 }, alt: "Gone", link: null }, { image: "m1", focalPoint: { x: 50, y: 50 }, alt: "Eid", link: null }];
    expect(homepageSectionRenders(section("hero", "h", { slides }), content())).toBe(true);
    expect(homepageSectionRenders(section("hero", "h", { slides }), empty)).toBe(false);
    expect(homepageSectionRenders(section("usp_strip", "u"), empty)).toBe(false);
    expect(homepageSectionRenders(section("usp_strip", "u", { style: "ticker", source: { kind: "custom", items: [{ title: "Open on Friday", detail: "" }] } }), empty)).toBe(true);
    expect(homepageSectionRenders(section("banner", "b", { mediaId: "missing" }), empty)).toBe(false);
    expect(homepageSectionRenders(section("banner", "b", { mediaId: "m1" }), content())).toBe(true);
    expect(homepageSectionRenders(section("banner", "b", { heading: "Sale" }), empty)).toBe(true);
    expect(homepageSectionRenders(section("faq", "f"), empty)).toBe(false);
    // The signup reads no store data: it always has its form.
    expect(homepageSectionRenders(section("newsletter", "n", { heading: "Join" }), empty)).toBe(true);
    expect(homepageSectionRenders(section("seo_text", "s", { heading: "", body: "\n\n" }), empty)).toBe(false);
  });

  it("leads with the first section that shows a photo", () => {
    const sections = [
      section("usp_strip", "u", { style: "icons", source: { kind: "custom", items: [{ title: "COD", detail: "" }] } }),
      section("banner", "text", { heading: "Words only" }),
      section("product_grid", "grid", { title: "", source: { kind: "newest" }, columns: 4, rows: 1 }),
      section("banner", "photo", { mediaId: "m1" }),
    ];
    expect(homepageLeadSection(sections, content())?.id).toBe("grid");
    expect(homepageLeadSection(sections.slice(3), content())?.id).toBe("photo");
  });

  it("puts consecutive two-up banners in pairs and four-up banners in fours", () => {
    const banner = (id: string, layout: string) => section("banner", id, { layout, heading: id });
    const units = homepageRenderUnits([
      banner("a", "two-up"), banner("b", "two-up"), banner("c", "two-up"),
      banner("d", "four-up"), banner("e", "four-up"),
      banner("f", "full"),
      banner("g", "two-up"),
    ], content());
    expect(units.map((unit) => unit.kind === "banners" ? unit.sections.map((each) => each.id).join("") : unit.section.id))
      .toEqual(["ab", "c", "de", "f", "g"]);
  });

  it("counts a deal down only to its running promotion's end still ahead", () => {
    const deal = (promotionId: string | null) => section("deal_block", "d", { promotionId }) as never;
    const ends = { promotionEnds: new Map([["promo-1", "2030-01-01T00:00:00Z"]]) };
    expect(dealEndsAt(deal("promo-1"), ends, Date.parse("2029-12-31T00:00:00Z"))).toBe("2030-01-01T00:00:00Z");
    expect(dealEndsAt(deal("promo-1"), ends, Date.parse("2030-01-02T00:00:00Z"))).toBeNull();
    expect(dealEndsAt(deal("promo-2"), ends, Date.parse("2029-12-31T00:00:00Z"))).toBeNull();
    expect(dealEndsAt(deal(null), ends)).toBeNull();
  });

  it("reads long store copy as subheadings and paragraphs", () => {
    expect(seoTextBlocks("## Laptops in Bangladesh\nThe best prices.\n\nPlain.\n\n## \n\n")).toEqual([
      { heading: "Laptops in Bangladesh", text: "The best prices." },
      { heading: null, text: "Plain." },
    ]);
  });
});
