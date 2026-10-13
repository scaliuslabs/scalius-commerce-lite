// @vitest-environment node
import { describe, expect, it } from "vitest";
import { homeSectionMediaIds, homeSectionRequests, resolveStorefrontTheme } from "@scalius/shared/storefront-theme";
import { answerFixtureApi, entryTheme, galleryApiBase, galleryStoreShape } from "./api";
import { galleryEntry, galleryEntries, type GalleryEntry } from "./entries";
import { cardProduct, cardProducts, productDetail, PRODUCT_SCENARIO_SLUGS, type CardProduct } from "./fixtures";
import { galleryIndex } from "./server";

const origin = "http://127.0.0.1:4799";
type Listing = {
  products: CardProduct[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  ratingFacet: Array<{ min: number; count: number }>;
  priceRange: { min: number; max: number };
};
type Sections = { sections: {
  lists: Array<{ key: string; products: CardProduct[] }>;
  collections: Array<{ products: CardProduct[] }>;
  media: Array<{ id: string }>;
} };
const entry = (count: 0 | 1 | 200) => galleryEntry(`catalog-${count}-home`)!;
const ids = (products: CardProduct[]) => products.map((product) => product.id);
const rangeIds = (start: number, length: number) => Array.from({ length }, (_, index) => `prod_${start + index}`);

async function read<T>(fixture: GalleryEntry, path: string): Promise<T> {
  const response = await answerFixtureApi(fixture, new Request(`${galleryApiBase(origin, fixture.id)}${path}`));
  expect(response.status).toBe(200);
  return (await response.json() as { data: T }).data;
}

describe("finite gallery catalogs", () => {
  it.each([0, 1, 200] as const)("offers %i products across distinct pages and then exhausts", async (total) => {
    const fixture = entry(total);
    expect(galleryEntry(`catalog-${total}-search`)?.scenario.catalogSize).toBe(total);
    expect(galleryStoreShape(fixture).productCount).toBe(total);
    const seen: CardProduct[] = [];
    for (let page = 1; page <= Math.ceil(total / 20) + 1; page++) {
      const result = await read<Listing>(fixture, `/api/v1/products?page=${page}&limit=20`);
      expect(result.pagination).toEqual({ page, limit: 20, total, totalPages: Math.ceil(total / 20) });
      expect(ids(result.products)).toEqual(rangeIds((page - 1) * 20, Math.min(20, Math.max(0, total - (page - 1) * 20))));
      expect(result.ratingFacet).toEqual([4, 3, 2, 1].map((min) => ({ min, count: cardProducts(total).filter((product) => product.rating && product.rating.average >= min).length })));
      if (total === 0) expect(result.priceRange).toEqual({ min: 0, max: 0 });
      seen.push(...result.products);
    }
    expect(ids(seen)).toEqual(rangeIds(0, total));
    expect(new Set(seen.map((product) => product.slug)).size).toBe(total);
  });

  it.each([
    "/api/v1/products", "/api/v1/categories/women/products",
    "/api/v1/collections/col-eid", "/api/v1/brands/samsung/products",
  ])("honors page size, partial last page and batch queries: %s", async (path) => {
    const fixture = entry(200);
    const query = `${path}?page=4&limit=60`;
    const single = await read<Listing & { collection?: Listing }>(fixture, query);
    expect(ids(single.products)).toEqual(rangeIds(180, 20));
    expect(single.pagination).toEqual({ page: 4, limit: 60, total: 200, totalPages: 4 });
    if (single.collection) {
      expect(single.collection.products).toEqual(single.products);
      expect(single.collection.pagination).toEqual(single.pagination);
    }
    const batch = await read<{ parts: Array<{ status: number; body: string }> }>(fixture, `/api/v1/storefront/batch?r=${encodeURIComponent(query)}`);
    expect(batch.parts[0]?.status).toBe(200);
    expect(JSON.parse(batch.parts[0]!.body).data).toEqual(single);
    expect((await read<Listing>(fixture, `${path}?page=5&limit=60`)).products).toEqual([]);
  });

  it("uses safe pagination defaults and preserves a requested empty search", async () => {
    const fixture = entry(200);
    const defaults = await read<Listing>(fixture, "/api/v1/products?page=-2&limit=NaN");
    expect(defaults.pagination.page).toBe(1);
    expect(defaults.pagination.limit).toBe(20);
    expect((await read<Listing>(fixture, "/api/v1/products?limit=999")).products).toHaveLength(60);
    const empty = await read<Listing>(fixture, "/api/v1/products?q=zzz-nothing");
    expect(empty.products).toEqual([]);
    expect(empty.pagination.total).toBe(0);
    expect(empty.ratingFacet.every((rating) => rating.count === 0)).toBe(true);
  });

  it.each([0, 1, 200] as const)("keeps real section request caps inside a %i-product catalog", async (total) => {
    const fixture = entry(total);
    const single = await read<Sections>(fixture, "/api/v1/storefront/homepage");
    const { sections } = single;
    const batch = await read<{ parts: Array<{ status: number; body: string }> }>(fixture, `/api/v1/storefront/batch?r=${encodeURIComponent("/api/v1/storefront/homepage")}`);
    expect(batch.parts[0]?.status).toBe(200);
    expect(JSON.parse(batch.parts[0]!.body).data).toEqual(single);
    const requests = homeSectionRequests(fixture.theme.pages.home);
    for (const list of sections.lists) {
      const limit = requests.lists.find((request) => request.key === list.key)!.limit;
      expect(ids(list.products)).toEqual(rangeIds(0, Math.min(total, limit)));
      expect(list.products.length).toBeLessThanOrEqual(36);
    }
    expect(sections.collections.length).toBeGreaterThan(0);
    for (const collection of sections.collections) expect(ids(collection.products)).toEqual(rangeIds(0, Math.min(total, 12)));
    const layout = await read<{ storeShape: { productCount: number } }>(fixture, "/api/v1/storefront/layout");
    expect(layout.storeShape.productCount).toBe(total);
  });

  it.each([0, 1, 200] as const)("keeps shelves and recommendations within %i identities, excluding source products", async (total) => {
    const fixture = entry(total);
    const shelf = await read<{ shelfProducts: CardProduct[] }>(fixture, "/api/v1/categories/women/products");
    expect(ids(shelf.shelfProducts)).toEqual(rangeIds(0, Math.min(total, 16)));
    const recommendations = await read<{ products: CardProduct[] }>(fixture, "/api/v1/products/recommendations?productIds=prod_0,prod_1&limit=8");
    expect(ids(recommendations.products)).toEqual(rangeIds(2, Math.min(Math.max(0, total - 2), 8)));
  });

  it("uses layout facts for gallery fit reporting and preserves the legacy large/small fixtures", async () => {
    const fixtures = [entry(0), entry(1), entry(200), galleryEntry("listing-results-small")!];
    const index = galleryIndex();
    for (const fixture of fixtures) {
      const layout = await read<{ storeShape: ReturnType<typeof galleryStoreShape> }>(fixture, "/api/v1/storefront/layout");
      const resolved = resolveStorefrontTheme(entryTheme(fixture), layout.storeShape);
      expect(index.find((item) => item.id === fixture.id)!.fallbacks).toEqual(resolved.fallbacks.map((fallback) => `${fallback.kind} ${fallback.key}: ${fallback.requested} -> ${fallback.resolved ?? "left out"}`));
    }
    const small = fixtures[3]!;
    expect((await read<Listing>(small, "/api/v1/products")).products).toHaveLength(5);
    const legacy = { ...small, scenario: {} };
    expect((await read<Listing>(legacy, "/api/v1/products")).pagination.total).toBe(1240);
    expect(galleryStoreShape(legacy).productCount).toBe(1000); // The real fit schema caps population facts.
    const { sections } = await read<Sections>(legacy, "/api/v1/storefront/homepage");
    sections.lists.forEach((list, index) => expect(list.products[0]?.id).toBe(`prod_${index * 5}`));
  });

  it("serves real Bangla load-more theme and the same finite continuation identities", async () => {
    const fixture = galleryEntry("catalog-200-home-load-more-bn")!;
    expect(fixture.scenario).toEqual({ catalogSize: 200, locale: "bn" });
    expect(fixture.theme.pages.home).toEqual(entry(200).theme.pages.home);
    const layout = await read<{ theme: GalleryEntry["theme"]; storefrontCopy: { languageCode: string } }>(fixture, "/api/v1/storefront/layout");
    expect(layout.theme.blocks.listing.paging).toBe("load-more");
    expect(layout.storefrontCopy.languageCode).toBe("bn");
    const last = await read<Listing>(fixture, "/api/v1/products?page=10&limit=20");
    expect(last.products).toEqual(cardProducts(20, 180, { bangla: true }));
    expect(last.pagination).toEqual({ page: 10, limit: 20, total: 200, totalPages: 10 });
  });

  it("leaves configured missing section media unresolved without altering the theme", async () => {
    const fixture = galleryEntry("catalog-missing-section-media")!;
    const before = JSON.stringify(fixture.theme);
    const requested = homeSectionRequests(fixture.theme.pages.home).mediaIds;
    for (const section of fixture.theme.pages.home) expect(homeSectionMediaIds(section).length).toBeGreaterThan(0);
    const absent = await read<Sections>(fixture, "/api/v1/storefront/homepage");
    expect(absent.sections.media).toEqual([]);
    const present = await read<Sections>({ ...fixture, scenario: { ...fixture.scenario, missingSectionMedia: false } }, "/api/v1/storefront/homepage");
    expect(present.sections.media.map((media) => media.id)).toEqual(requested);
    expect(JSON.stringify(fixture.theme)).toBe(before);
  });
});


describe("gallery product journeys", () => {
  it("resolves card and recommendation identities without swapping their product", async () => {
    const fixture = entry(200);
    const cards = cardProducts(33);
    const recommended = await read<{ products: CardProduct[] }>(fixture, "/api/v1/products/recommendations?productIds=prod_0&limit=8");
    for (const card of [...cards, ...recommended.products]) {
      const detail = await read<ReturnType<typeof productDetail>>(fixture, `/api/v1/products/${card.slug}`);
      expect(detail.product).toMatchObject({ id: card.id, slug: card.slug, name: card.name, price: card.price, discountedPrice: card.discountedPrice, hasVariants: card.hasVariants });
      expect(detail.variants.every((variant) => variant.productId === card.id)).toBe(true);
      expect(detail.variants.every((variant) => !variant.imageId || detail.media.some((media) => media.id === variant.imageId))).toBe(true);
    }
  });

  it("resolves the declared product of every existing product case", async () => {
    for (const fixture of galleryEntries().filter((candidate) => candidate.page === "product")) {
      const slug = PRODUCT_SCENARIO_SLUGS[fixture.scenario.product ?? "fashion"];
      const detail = await read<ReturnType<typeof productDetail>>(fixture, `/api/v1/products/${slug}`);
      expect(detail.product.slug).toBe(slug);
    }
  });

  it.each(["product-state-bangla", "noor-product-bn"])("keeps localized listing and recommendation identities in %s", async (id) => {
    const fixture = galleryEntry(id)!;
    const listed = await read<Listing>(fixture, "/api/v1/products?limit=16");
    const recommended = await read<{ products: CardProduct[] }>(fixture, "/api/v1/products/recommendations?productIds=prod_0&limit=8");
    for (const card of [...listed.products, ...recommended.products]) {
      const detail = await read<ReturnType<typeof productDetail>>(fixture, `/api/v1/products/${card.slug}`);
      expect(detail.product).toMatchObject({ id: card.id, name: card.name, slug: card.slug, price: card.price });
    }
  });

  it("refuses forged or out-of-catalog slugs", async () => {
    for (const slug of ["forged-3", "cotton-panjabi-999999", cardProduct(1).slug]) {
      const response = await answerFixtureApi(entry(1), new Request(`${galleryApiBase(origin, entry(1).id)}/api/v1/products/${slug}`));
      expect(response.status).toBe(404);
    }
  });

  it("gives the one-image case exactly one image and no hover image", async () => {
    const fixture = galleryEntry("product-state-one-image")!;
    const detail = await read<ReturnType<typeof productDetail>>(fixture, "/api/v1/products/mi-tv-box");
    expect(detail.media).toHaveLength(1);
    expect(detail.product.secondaryImageUrl).toBeNull();
    expect(fixture.focus.include.join()).toContain("data-product-gallery");
  });

  it("makes body blocks and dense RTL tabs real required subjects", async () => {
    const fixture = galleryEntry("product-content-blocks")!;
    const detail = await read<{ product: { contentBlocks: Array<{ type: string }> } }>(fixture, "/api/v1/products/jamdani-saree");
    expect(detail.product.contentBlocks.map((block) => block.type)).toEqual(["rich-text", "feature-list", "faq"]);
    expect(fixture.theme.blocks.product.below).toContain("content-blocks");
    expect(fixture.focus.include).toEqual(["[data-product-content-blocks] [data-content-block]"]);
    const rtl = galleryEntry("product-tabs-dense-rtl")!;
    const tabs = await read<{ product: { additionalInfo: unknown[] } }>(rtl, "/api/v1/products/jamdani-saree");
    expect(tabs.product.additionalInfo).toHaveLength(5);
    expect(rtl.scenario.locale).toBe("ar");
    expect(rtl.theme.blocks.product.sticky.desktop).toBe("none");
  });

  it("keeps remembered public products after the exact-id check and omits gone ids", async () => {
    const fixture = galleryEntry("home-recently-viewed")!;
    const remembered = JSON.parse(fixture.scenario.storage!["scalius:recently-viewed:v2"]!) as Array<{ id: string; slug: string; image: string }>;
    expect(remembered).toHaveLength(3);
    const result = await read<Listing>(fixture, `/api/v1/products?ids=${remembered.map((product) => product.id).join(",")},prod_99999&limit=12`);
    expect(ids(result.products)).toEqual(remembered.map((product) => product.id));
    for (const product of remembered) {
      expect(product.image).toMatch(/^\/(?!\/)/);
      expect((await read<ReturnType<typeof productDetail>>(fixture, `/api/v1/products/${product.slug}`)).product.id).toBe(product.id);
    }
    expect(fixture.focus.include[0]).toContain(":not([hidden])");
  });

  it("models unavailable COD separately from the working landing checkout", async () => {
    const fixture = galleryEntry("noor-landing-no-cod")!;
    expect((await read<{ gateways: unknown[] }>(fixture, "/api/v1/checkout/config")).gateways).toEqual([]);
    expect(fixture.focus.include).toEqual([".scalius-order-form-unavailable"]);
    expect(JSON.stringify(fixture.theme.pages.landing)).not.toMatch(/cash on delivery|\bCOD\b/i);
  });
});
