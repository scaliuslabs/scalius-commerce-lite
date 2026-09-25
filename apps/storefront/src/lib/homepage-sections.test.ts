import { describe, expect, it } from "vitest";
import { storefrontSectionDefault, type StorefrontSection } from "@scalius/shared/storefront-theme";
import {
  dealEndsAt,
  homepageCollectionsFallback,
  homepageContent,
  homepageLeadSection,
  homepageRenderUnits,
  homepageSectionProducts,
  homepageSectionRenders,
  seoTextBlocks,
  type HomepageContent,
} from "./homepage-sections";

const product = (id: string) => ({ id, name: id, slug: id }) as never;
const section = (type: StorefrontSection["type"], id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

function content(overrides: Partial<HomepageContent> = {}): HomepageContent {
  return {
    ...homepageContent({
      hero: { desktop: null, mobile: null },
      collections: [],
      presentation: { categoryRail: { enabled: false, title: "", categories: [] }, trustStrip: { enabled: false } },
      sections: {
        lists: [
          { key: "newest", products: Array.from({ length: 12 }, (_, index) => product(`n${index}`)), category: null, collection: null },
          { key: "popular", products: [product("hit")], category: null, collection: null },
          { key: "category:cat", products: [product("c1")], category: { id: "cat", name: "Tea", slug: "tea", canonicalPath: "/categories/green-tea" }, collection: null },
          { key: "category:gone", products: [product("x")], category: null, collection: null },
          { key: "collection:col", products: [product("k1")], category: null, collection: { id: "col", title: "Eid edit" } },
        ],
        media: [{ id: "m1", url: "https://cdn.test/m1.jpg", alt: "Eid", width: 10, height: 10 }],
      },
    } as never, []),
    ...overrides,
  };
}

describe("homepage section products", () => {
  it("titles lists by what they are unless the merchant named them, and links the whole list", () => {
    expect(homepageSectionProducts(section("product-rail", "a", { title: "", source: { kind: "newest" }, limit: 4 }), content()))
      .toMatchObject({ title: "New arrivals", href: "/search", products: { length: 4 } });
    expect(homepageSectionProducts(section("product-rail", "a", { title: "  Fresh  ", source: { kind: "newest" }, limit: 4 }), content())?.title)
      .toBe("Fresh");
    expect(homepageSectionProducts(section("product-grid", "b", { title: "", source: { kind: "category", categoryId: "cat" }, columns: 2, rows: 1 }), content()))
      .toMatchObject({ title: "Tea", href: "/categories/green-tea" });
    expect(homepageSectionProducts(section("product-rail", "c", { title: "", source: { kind: "collection", collectionId: "col" }, limit: 4 }), content()))
      .toMatchObject({ title: "Eid edit", href: "/collections/col" });
    // Popular has no listing to link to.
    expect(homepageSectionProducts(section("product-rail", "d", { title: "", source: { kind: "popular" }, limit: 4 }), content())?.href).toBeNull();
    // Products of a category that is no longer public never show under a made-up title.
    expect(homepageSectionProducts(section("product-rail", "e", { title: "Tea", source: { kind: "category", categoryId: "gone" }, limit: 4 }), content())).toBeNull();
    // A source the read did not return renders nothing.
    expect(homepageSectionProducts(section("deal-block", "f", { title: "", source: { kind: "on-sale" }, endsAt: null }), content())).toBeNull();
  });

  it("shows the newest products for a collections section only without homepage collections", () => {
    expect(homepageCollectionsFallback(content())).toHaveLength(8);
    expect(homepageCollectionsFallback(content({ collections: [{ id: "c", presentation: "grid", products: [product("p")] } as never] }))).toEqual([]);
  });
});

describe("homepage section rules", () => {
  it("renders a section only with data", () => {
    const empty = content({ lists: new Map(), media: new Map() });
    expect(homepageSectionRenders(section("hero", "h"), empty)).toBe(false);
    expect(homepageSectionRenders(section("usp-strip", "u"), empty)).toBe(false);
    expect(homepageSectionRenders(section("usp-strip", "u", { style: "ticker", source: { kind: "custom", items: [{ title: "Open on Friday", detail: "" }] } }), empty)).toBe(true);
    expect(homepageSectionRenders(section("banner", "b", { mediaId: "missing" }), empty)).toBe(false);
    expect(homepageSectionRenders(section("banner", "b", { mediaId: "m1" }), content())).toBe(true);
    expect(homepageSectionRenders(section("banner", "b", { heading: "Sale" }), empty)).toBe(true);
    expect(homepageSectionRenders(section("faq", "f"), empty)).toBe(false);
    expect(homepageSectionRenders(section("newsletter", "n", { heading: "Join" }), content())).toBe(false);
    expect(homepageSectionRenders(section("seo-text", "s", { heading: "", body: "\n\n" }), empty)).toBe(false);
  });

  it("leads with the first section that shows a photo", () => {
    const sections = [
      section("usp-strip", "u", { style: "icons", source: { kind: "custom", items: [{ title: "COD", detail: "" }] } }),
      section("banner", "text", { heading: "Words only" }),
      section("product-grid", "grid", { title: "", source: { kind: "newest" }, columns: 4, rows: 1 }),
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
    const deal = (promotionId: string | null) => section("deal-block", "d", { promotionId }) as never;
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
