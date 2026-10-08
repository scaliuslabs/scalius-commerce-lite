// @vitest-environment node
/**
 * Render-only listing coverage (no browser): renders the real catalog Astro
 * components with Astro's container API for every listing layout, toolbar
 * piece, phone layout and paging mode, and checks the markup each promises.
 * The default listing (department-mall: compact department tiles) is pinned
 * as whole-markup baselines in __fixtures__ (`UPDATE_CATALOG_BASELINE=1`
 * rewrites them after an intended change).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import {
  buildStorefrontThemeTokens,
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontTemplateTheme,
  type StoreShape,
  type StorefrontThemeBlocks,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { listingFilterColumnPx, productCardImageSizes, productGridSpec } from "@/lib/product-card-layout";
import { LIST_ROW_IMAGE_SIZES } from "@/lib/catalog-listing";
import { capPhoneSizesDensity, scaleSizes } from "@/lib/responsive-image";
import { requestThemeFor } from "@/lib/storefront-theme-context";
import { resolveProductListQueryState } from "@/lib/product-list-query";
import type { ProductFacet } from "@/lib/api";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const fixtures = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

interface Container {
  renderToString(
    component: unknown,
    options: { props?: object; slots?: Record<string, string>; locals?: object; request?: Request },
  ): Promise<string>;
}

let server: ViteDevServer;
let container: Container;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "catalog-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0catalog-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0catalog-test:") ? VIRTUAL_MODULES[id.slice("\0catalog-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react",
    renderer: reactRenderer,
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const STORE_SHAPE = storeShapeFromFacts({
  productCount: 120,
  skuCount: 300,
  topCategoryCount: 8,
  categoryDepth: 1,
  menu: [],
  hasCollections: true,
  hasDeliveryMethods: true,
});

/** The store once the category tree and typed specs exist (Phases 1a and 1b). */
const TREE_STORE_SHAPE = storeShapeFromFacts({
  productCount: 120,
  skuCount: 300,
  topCategoryCount: 8,
  categoryDepth: 2,
  menu: [],
  hasCollections: true,
  hasDeliveryMethods: true,
  hasKeySpecs: true,
});

async function render(
  path: string,
  theme: StorefrontThemeDocument,
  props: object,
  slots?: Record<string, string>,
  shape: StoreShape = STORE_SHAPE,
): Promise<string> {
  const component = (await server.ssrLoadModule(path)).default;
  return container.renderToString(component, {
    props,
    slots,
    locals: { storefrontTheme: Promise.resolve(requestThemeFor(theme, shape)) },
    request: new Request("https://shop.test/categories/sarees"),
  });
}

/**
 * The rendered markup as it paints with JavaScript on: Astro's per-build
 * ids, scripts, `<noscript>` fallbacks, styles and stylesheet links removed,
 * and one element per line with its attributes and class tokens sorted
 * (their order never changes a pixel).
 */
function normalize(html: string): string {
  const document = new Window().document;
  const body = document.createElement("body");
  body.innerHTML = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<link\b[^>]*>/g, "");
  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    for (const child of Array.from(node.childNodes)) {
      const indent = "  ".repeat(depth);
      if (child.nodeType === 3) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ");
        if (text.trim()) lines.push(`${indent}"${text}"`);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const attributes = Array.from(element.attributes)
        .filter((attribute) => !attribute.name.startsWith("data-astro-cid"))
        .map((attribute) => {
          const value = attribute.name === "class"
            ? attribute.value.split(/\s+/).filter(Boolean).sort().join(" ")
            : attribute.value;
          return `${attribute.name}="${value}"`;
        })
        .sort();
      lines.push(`${indent}<${element.tagName.toLowerCase()}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`);
      walk(element.tagName === "TEMPLATE" ? (element as HTMLTemplateElement).content : element, depth + 1);
    }
  };
  walk(body as unknown as Node, 0);
  return `${lines.join("\n")}\n`;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const image = (name: string) => `https://cdn.shop.test/products/${name}.jpg`;
function product(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: null,
    price: 1200,
    discountedPrice: 1200,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    freeDelivery: false,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    categoryId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: image(id),
    imageAlt: null,
    hasVariants: false,
    availableForSale: true,
    ...overrides,
  };
}

const PRODUCTS = Array.from({ length: 20 }, (_, index) =>
  product(`p${index + 1}`, index % 5 === 0 ? { discountedPrice: 960, discountType: "percentage", discountPercentage: 20 } : {}));
/** A facet as the API sends it; each value's label is its URL value unless given. */
function facet(
  slug: string,
  name: string,
  values: Array<[value: string, count: number, label?: string, swatch?: string]>,
  overrides: Partial<ProductFacet> = {},
): ProductFacet {
  return {
    id: slug.startsWith("option.") || slug === "brand" ? slug : `attr-${slug}`,
    name,
    slug,
    kind: slug === "brand" ? "brand" : slug.startsWith("option.") ? "option" : "attribute",
    display: "checkbox",
    unit: null,
    values: values.map(([value, count, label, swatch]) => ({ value, label: label ?? value, count, swatch: swatch ?? null })),
    range: null,
    ...overrides,
  };
}

const FACETS: ProductFacet[] = [
  facet("size", "Size", [["S", 12], ["M", 20], ["L", 0]]),
  // Eleven values: ten shown and one folded, below the search-list threshold.
  facet("fabric", "Fabric", Array.from({ length: 11 }, (_, index): [string, number] => [`Fabric ${index + 1}`, index + 1])),
  facet("origin", "Origin", [["Bangladesh", 50]]),
];

/** A number attribute the merchant shows as a range. */
const DISPLAY_SIZE = facet("display-size", "Display size", [], {
  display: "range",
  unit: "in",
  range: { min: 11.6, max: 17.3 },
});

function listingProps(url: string, overrides: Record<string, unknown> = {}, facets: ProductFacet[] = FACETS) {
  const queryState = resolveProductListQueryState({ url: new URL(url), facets });
  return {
    products: PRODUCTS,
    pagination: { page: queryState.page, totalPages: 3, total: 50 },
    facets,
    priceRange: { min: 500, max: 4500 },
    queryState,
    pathname: new URL(url).pathname,
    resetPath: new URL(url).pathname,
    searchLabel: "Search this category",
    countEndpoint: "/categories/sarees/products",
    currencySymbol: "৳",
    currencyCode: "BDT",
    band: { title: "Sarees", breadcrumb: [{ label: "Home", href: "/" }], countLabel: "50 products" },
    ...overrides,
  };
}

const EMPTY_SLOT = { empty: '<section data-catalog-empty-state>Nothing here</section>' };

/** The default (grid with the sidebar filters) listing states whose markup must not change. */
const BASELINES: Record<string, () => Record<string, unknown>> = {
  plain: () => listingProps("https://shop.test/categories/sarees"),
  filtered: () =>
    listingProps("https://shop.test/categories/sarees?size=M&fabric=Fabric+11&minPrice=600&hasDiscount=true&page=2&sortBy=price-asc"),
  search: () =>
    listingProps("https://shop.test/search?q=linen", { kind: "search", pathname: "/search", resetPath: "/search?q=linen", searchLabel: "Search products", countEndpoint: "/products" }),
  empty: () =>
    listingProps("https://shop.test/categories/sarees?size=L", { products: [], pagination: { page: 1, totalPages: 0, total: 0 } }),
};

describe("default listing (department-mall: compact department tiles)", () => {
  it.each(Object.keys(BASELINES))("renders the %s state as its baseline", async (name) => {
    const html = normalize(
      await render("/src/components/catalog/CatalogListing.astro", DEFAULT_STOREFRONT_THEME, BASELINES[name]!(), EMPTY_SLOT),
    );
    const file = `${fixtures}sidebar-grid-${name}.html`;
    if (process.env.UPDATE_CATALOG_BASELINE === "1") {
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(file, html);
    }
    expect(html).toBe(readFileSync(file, "utf8"));
  });
});

// ─── Listing templates ──────────────────────────────────────────────────

const LISTING = "/src/components/catalog/CatalogListing.astro";
const PAGE = "/src/components/catalog/CatalogListingPage.astro";

function parse(html: string): Document {
  return new new Window().DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

function duplicateIds(document: Document): string[] {
  const seen = new Set<string>();
  return Array.from(document.querySelectorAll("[id]"))
    .map((element) => element.id)
    .filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

/** The default theme with another listing block (and card). */
function themeWith(
  listing: Partial<StorefrontThemeBlocks["listing"]> & { variant?: string; settings?: Record<string, unknown> },
  card?: StorefrontThemeBlocks["card"],
): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  const { variant, settings, ...rest } = listing;
  if (variant) theme.blocks.listing.layout = { variant, settings: settings ?? {} } as never;
  // Layouts that used to carry their own filter bar keep it in these tests.
  if (variant === "shelves" || variant === "quick-grid") theme.blocks.listing.filters = { style: "drawer", openByDefault: false, searchPlacement: "same", ruled: false };
  Object.assign(theme.blocks.listing, rest);
  if (card) theme.blocks.card = card;
  return theme;
}

async function renderListing(
  theme: StorefrontThemeDocument,
  props: Record<string, unknown>,
  shape?: StoreShape,
): Promise<Document> {
  const document = parse(await render(LISTING, theme, props, EMPTY_SLOT, shape));
  expect(duplicateIds(document)).toEqual([]);
  return document;
}

const plain = () => listingProps("https://shop.test/categories/sarees");
/** The one card with every setting off, so layout tests see the photo and the price alone. */
const STANDARD_CARD = { variant: "standard", settings: { facts: "none", action: "none", hoverImage: false } } as StorefrontThemeBlocks["card"];
/**
 * What ProductCard asks for a photo in `slot`: a contained photo is drawn in a
 * 6% margin, so 88% of the slot; phones at DPR 2.5+ ask for about 2x.
 */
const cardSizes = (slot: string, theme: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME) =>
  capPhoneSizesDensity(scaleSizes(slot, requestThemeFor(theme, STORE_SHAPE).layout.productCard.imageFit === "contain" ? 0.88 : 1));
const gridSizes = (context: "grid" | "beside-filters", theme: StorefrontThemeDocument = DEFAULT_STOREFRONT_THEME) => {
  const request = requestThemeFor(theme, STORE_SHAPE);
  const layout = request.layout;
  const width = buildStorefrontThemeTokens(theme)["theme-container-width"]!;
  const filterColumnPx = context === "beside-filters" ? listingFilterColumnPx(request.resolved.blocks.listing.filters) : 0;
  const slot = productCardImageSizes(productGridSpec(layout.grid, layout.productCard.imageRatio), width, context, "grid", undefined, filterColumnPx);
  return cardSizes(slot, theme);
};

/**
 * The listing settings the five retired presets (Star Tech, Target, Fabrilife,
 * Apple Gadgets, Aarong) used, now plain settings on the department mall:
 * the blocks keep every one of them, so a merchant can still choose them.
 */
const PRICE_FIRST = ["price", "availability", "rating", "brand", "other", "category"] as const;
function mallWith(listing: Record<string, unknown>, header?: string): StorefrontThemeDocument {
  const theme = storefrontTemplateTheme("department-mall");
  if (header) theme.blocks.header = { variant: header, settings: { search: header === "search-first" ? "field" : "icon", rowTone: "page", cartTotal: false } } as never;
  Object.assign(theme.blocks.listing, listing);
  return theme;
}
/** Star Tech: a dense price-first rail, the title band beside it, searches spending the full width on results. */
const specListingTheme = () => mallWith({
  filters: { style: "sidebar-dense", openByDefault: true, column: 225, rowPitch: 32, label: 14, order: [...PRICE_FIRST], searchPlacement: "drawer", ruled: false },
  toolbar: ["breadcrumb", "subcategory-pills", "result-count", "sort", "per-page", "applied-chips"],
  band: "beside-filters",
}, "search-first");
/** Target: a filter drawer, rows for searches, the phone's one scrolling pill row, four columns at most. */
const pillRowListingTheme = () => mallWith({
  searchLayout: "list",
  filters: { style: "drawer", openByDefault: false, searchPlacement: "same", ruled: false },
  toolbar: ["breadcrumb", "popular-filter-chips", "result-count", "sort", "grid-list-toggle", "applied-chips"],
  phoneBar: "pill-row",
  maxColumns: 4,
});
/** Fabrilife: a ruled department rail and the phone's Filter and Sort row pinned to the bottom. */
const ruledRailListingTheme = () => mallWith({
  filters: { style: "sidebar-comfortable", openByDefault: true, searchPlacement: "same", ruled: true },
  toolbar: ["breadcrumb", "subcategory-pills", "result-count", "sort", "applied-chips"],
  paging: "infinite",
  phoneBar: "bottom",
});
/** Apple Gadgets: price first in a comfortable rail, the category banner on computers only. */
const comfortableListingTheme = () => mallWith({
  filters: { style: "sidebar-comfortable", openByDefault: true, column: 316, rowPitch: 28, label: 16, order: [...PRICE_FIRST], searchPlacement: "same", ruled: false },
  toolbar: ["breadcrumb", "category-banner", "result-count", "sort", "applied-chips"],
  phoneBanner: false,
});

describe("listing layouts", () => {
  it("defaults Marketplace categories to cards and searches to rows, with both view controls", async () => {
    const theme = storefrontTemplateTheme("marketplace");
    const category = await renderListing(theme, { ...plain(), kind: "category" }, TREE_STORE_SHAPE);
    expect(category.querySelector("[data-catalog-kind]")!.getAttribute("data-catalog-kind")).toBe("category");
    expect(category.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");
    expect(category.querySelector(".product-grid")!.hasAttribute("data-phone-layout")).toBe(false);
    expect(category.querySelector("[data-catalog-layout='sidebar'] > #filter-section[data-placement='sidebar']")).not.toBeNull();
    expect(category.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);

    const search = await renderListing(theme, {
      ...listingProps("https://shop.test/search?q=keyboard"), kind: "search",
    }, TREE_STORE_SHAPE);
    expect(search.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    expect(search.querySelector("[data-catalog-layout='sidebar'] > #filter-section[data-placement='sidebar']")).not.toBeNull();
    expect(search.querySelector(".product-card-media img")!.getAttribute("sizes")).not.toBe(LIST_ROW_IMAGE_SIZES);
    expect(search.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);
    expect(search.querySelector("[data-catalog-view-toggle] button[data-view='list']")!.getAttribute("aria-pressed")).toBe("true");
    expect(category.querySelector("[data-catalog-view-storage-key]")!.getAttribute("data-catalog-view-storage-key")).toBe("scalius:listing-view:browse");
    expect(search.querySelector("[data-catalog-view-storage-key]")!.getAttribute("data-catalog-view-storage-key")).toBe("scalius:listing-view:search");
  });

  it("uses the merchant's search view without changing category cards", async () => {
    const theme = storefrontTemplateTheme("marketplace");
    theme.blocks.listing.searchLayout = "grid";
    theme.blocks.listing.layout = { variant: "list", settings: {} };
    const category = await renderListing(theme, { ...plain(), kind: "category" }, TREE_STORE_SHAPE);
    const search = await renderListing(theme, { ...listingProps("https://shop.test/search?q=keyboard"), kind: "search" }, TREE_STORE_SHAPE);
    expect(category.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    expect(search.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");
  });

  it("reads the search view from the document, never from the template it is based on", async () => {
    // A Marketplace-based theme states its list search; any template's theme can choose it.
    expect(storefrontTemplateTheme("marketplace").blocks.listing.searchLayout).toBe("list");
    const theme = storefrontTemplateTheme("boutique");
    theme.blocks.listing.searchLayout = "list";
    const search = await renderListing(theme, { ...listingProps("https://shop.test/search?q=keyboard"), kind: "search" }, TREE_STORE_SHAPE);
    expect(search.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
  });

  it("the drawer filter style puts the facets in a drawer behind a filter bar, over a full-width grid", async () => {
    const theme = themeWith({ filters: { style: "drawer", openByDefault: false, searchPlacement: "same", ruled: false }, toolbar: ["result-count", "sort", "per-page"] }, STANDARD_CARD);
    const document = await renderListing(theme, plain());
    const drawer = document.querySelector("#filter-section")!;
    expect(drawer.getAttribute("data-catalog-dialog")).toBe("drawer");
    expect(drawer.className).not.toContain("lg:static");
    // The Filter button, quick chips and view controls share the title band's line.
    const bar = document.querySelector("[data-catalog-band]")!;
    expect(bar.querySelector("h1")!.textContent).toBe("Sarees");
    expect(bar.querySelector("button[data-catalog-filter-toggle][aria-controls='filter-section']")).not.toBeNull();
    expect(bar.textContent).toContain("50 products");
    expect(bar.querySelector("select[name='sortBy']")).not.toBeNull();
    expect(bar.querySelector("select[name='limit']")).not.toBeNull();
    // The shopping switches are one-tap chips in the bar (plain links).
    expect(Array.from(bar.querySelectorAll("nav[aria-label='Quick filters'] a")).map((link) => link.getAttribute("href")))
      .toEqual(["/categories/sarees?hasDiscount=true", "/categories/sarees?freeDelivery=true"]);
    // The drawer's form waits for its apply button; the bar stays inside the drawer.
    const form = document.querySelector("form[data-catalog-filters]")!;
    expect(form.getAttribute("data-catalog-apply")).toBe("sheet");
    expect(form.lastElementChild!.className).toContain("sticky");
    // No sidebar beside the grid, so cards size for the full width.
    expect(document.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(gridSizes("grid", theme));
  });

  it("list shows one product per row beside the sidebar", async () => {
    const document = await renderListing(themeWith({ variant: "list" }, STANDARD_CARD), plain());
    expect(document.querySelector("#filter-section")!.className).toContain("lg:static");
    expect(document.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    expect(document.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(cardSizes(LIST_ROW_IMAGE_SIZES));
    // A contained photo is drawn in a margin, so its row photo asks for 88% of the column.
    const contained = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
    contained.tokens.imageFit = "contain";
    contained.blocks.listing.layout = { variant: "list", settings: {} } as never;
    const mall = await renderListing(contained, plain());
    expect(mall.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(cardSizes(LIST_ROW_IMAGE_SIZES, contained));
    expect(mall.querySelector(".product-card-media img")!.getAttribute("sizes")).not.toBe(cardSizes(LIST_ROW_IMAGE_SIZES));
  });

  it("quick-grid packs its own denser grid with any card", async () => {
    for (const card of [STANDARD_CARD, { variant: "standard", settings: { facts: "swatches", action: "quick-add", hoverImage: true } } as StorefrontThemeBlocks["card"]]) {
      const document = await renderListing(themeWith({ variant: "quick-grid" }, card), plain());
      const frame = document.querySelector(".product-grid-frame")!;
      expect(frame.getAttribute("data-catalog-results")).toBe("quick");
      expect(frame.getAttribute("style")).toContain("--theme-card-min-phone:6.5rem");
      expect(document.querySelector("#filter-section")!.getAttribute("data-catalog-dialog")).toBe("drawer");
      expect(frame.querySelectorAll("[data-theme-component='product-card']").length).toBeGreaterThan(0);
    }
    // The theme's own card renders too: no card is required.
    const fallback = await renderListing(themeWith({ variant: "quick-grid" }), plain());
    expect(fallback.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("quick");
  });

  it("lets buyers switch a quick-grid category listing to list rows", async () => {
    const quickAdd = { variant: "standard", settings: { facts: "none", action: "quick-add", hoverImage: false } } as StorefrontThemeBlocks["card"];
    const document = await renderListing(themeWith({ variant: "quick-grid", phoneLayout: "list-row", toolbar: ["grid-list-toggle"] }, quickAdd), plain());
    const frame = document.querySelector(".product-grid-frame")!;
    expect(frame.getAttribute("data-catalog-results")).toBe("grid");
    expect(frame.getAttribute("style")).toContain("--theme-card-min-phone:6.5rem");
    expect(frame.getAttribute("data-catalog-view-storage-key")).toBe("scalius:listing-view:browse");
    // The restored list view's row photo.
    expect(frame.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(cardSizes(LIST_ROW_IMAGE_SIZES));
    expect(frame.querySelector(".product-grid")!.hasAttribute("data-phone-layout")).toBe(false);
    expect(document.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);
    expect(document.querySelector("[data-catalog-view-mobile] [data-view='grid']")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("shelves group the first page by sub-listing, with View all links, and fall back to the grid", async () => {
    const theme = themeWith({ variant: "shelves", settings: { maxShelves: 8 } });
    const products = PRODUCTS.map((item, index) => ({ ...item, categoryId: index % 3 === 0 ? "c-cotton" : index % 3 === 1 ? "c-silk" : null }));
    const subListings = [
      { id: "c-cotton", label: "Cotton", href: "/categories/cotton" },
      { id: "c-silk", label: "Silk", href: "/categories/silk" },
    ];
    const document = await renderListing(theme, { ...plain(), products, subListings, listingName: "Sarees" });
    const shelves = Array.from(document.querySelectorAll("[data-catalog-shelves] section"));
    expect(shelves.map((shelf) => shelf.querySelector("h2")!.textContent!.trim())).toEqual(["Cotton", "Silk", "More from Sarees"]);
    expect(shelves.map((shelf) => shelf.querySelector("a[href^='/categories/']:not(.product-card-link)")?.getAttribute("href") ?? null))
      .toEqual(["/categories/cotton", "/categories/silk", null]);
    expect(shelves[0]!.querySelectorAll("[data-theme-component='product-card']")).toHaveLength(7);
    expect(document.querySelector(".product-grid")).toBeNull();
    // Page links stay for the rest of the listing.
    expect(document.querySelector("nav[aria-label='Pagination'] a[href='/categories/sarees?page=2']")).not.toBeNull();

    // A filtered view, or a listing without sub-listings, lists products in the grid.
    const filtered = await renderListing(theme, { ...listingProps("https://shop.test/categories/sarees?size=M"), products, subListings });
    expect(filtered.querySelector("[data-catalog-shelves]")).toBeNull();
    expect(filtered.querySelector(".product-grid")).not.toBeNull();
    const flat = await renderListing(theme, { ...plain(), products });
    expect(flat.querySelector("[data-catalog-shelves]")).toBeNull();
    expect(flat.querySelector("#filter-section")!.getAttribute("data-catalog-dialog")).toBe("drawer");
  });

  it("shows child shelves whose products fall after the normal first page", async () => {
    const theme = themeWith({ variant: "shelves", settings: { maxShelves: 8 } });
    const products = PRODUCTS.map((item) => ({ ...item, categoryId: "c-cotton" }));
    const silk = PRODUCTS.slice(0, 3).map((item, index) => ({
      ...item, id: `late-silk-${index}`, categoryId: "c-silk",
    }));
    const subListings = [
      { id: "c-cotton", label: "Cotton", href: "/categories/cotton" },
      { id: "c-silk", label: "Silk", href: "/categories/silk" },
    ];
    const document = await renderListing(theme, {
      ...plain(), products, shelfProducts: [...products, ...silk], subListings,
    });
    const shelves = Array.from(document.querySelectorAll("[data-catalog-shelves] section"));
    expect(shelves.map((shelf) => shelf.querySelector("h2")!.textContent!.trim())).toEqual(["Cotton", "Silk"]);
    expect(shelves[1]!.querySelectorAll("[data-theme-component='product-card']")).toHaveLength(3);
  });

  it("marks airy shelves for their wider card spacing", async () => {
    const theme = themeWith({ variant: "shelves", settings: { maxShelves: 8, spacing: "airy" } });
    const document = await renderListing(theme, {
      ...plain(),
      products: PRODUCTS.map((item, index) => ({ ...item, categoryId: index % 2 ? "silk" : "cotton" })),
      subListings: [
        { id: "cotton", label: "Cotton", href: "/categories/cotton" },
        { id: "silk", label: "Silk", href: "/categories/silk" },
      ],
    });
    expect(document.querySelector("[data-catalog-shelves][data-catalog-heritage]")).not.toBeNull();
    // Standard spacing leaves the mark off.
    const standard = await renderListing(themeWith({ variant: "shelves", settings: { maxShelves: 8, spacing: "standard" } }), {
      ...plain(),
      products: PRODUCTS.map((item, index) => ({ ...item, categoryId: index % 2 ? "silk" : "cotton" })),
      subListings: [
        { id: "cotton", label: "Cotton", href: "/categories/cotton" },
        { id: "silk", label: "Silk", href: "/categories/silk" },
      ],
    });
    expect(standard.querySelector("[data-catalog-shelves]")).not.toBeNull();
    expect(standard.querySelector("[data-catalog-heritage]")).toBeNull();
  });

  it("lets buyers switch category shelves to grouped list rows without duplicating cards", async () => {
    const theme = themeWith({ toolbar: ["grid-list-toggle"] });
    const products = PRODUCTS.map((item, index) => ({ ...item, categoryId: index % 2 ? "c-silk" : "c-cotton" }));
    const subListings = [
      { id: "c-cotton", label: "Cotton", href: "/categories/cotton" },
      { id: "c-silk", label: "Silk", href: "/categories/silk" },
    ];
    const page = { ...plain(), products, subListings, listingTemplate: "shelves" };
    const landing = await renderListing(theme, page, TREE_STORE_SHAPE);
    const shelfFrame = landing.querySelector("[data-catalog-shelf-view]")!;
    expect(shelfFrame.getAttribute("data-catalog-results")).toBe("grid");
    expect(shelfFrame.getAttribute("data-catalog-view-storage-key")).toBe("scalius:listing-view:browse");
    expect(shelfFrame.querySelector("[data-catalog-shelves]")).not.toBeNull();
    expect(shelfFrame.querySelectorAll("[data-theme-component='product-card']")).toHaveLength(products.length);
    expect(landing.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);
    const restore = [...landing.querySelectorAll("script")].find((script) => script.textContent?.includes("localStorage.getItem"))!;
    new Function("document", "localStorage", restore.textContent!)(
      { currentScript: restore }, { getItem: () => "list" },
    );
    expect(shelfFrame.getAttribute("data-catalog-results")).toBe("list");

    const filtered = await renderListing(theme, {
      ...listingProps("https://shop.test/categories/sarees?size=M"), products, subListings, listingTemplate: "shelves",
    }, TREE_STORE_SHAPE);
    expect(filtered.querySelector("[data-catalog-shelves]")).toBeNull();
    expect(filtered.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);
  });

  it("uses list rows on phones when the theme asks for them", async () => {
    const document = await renderListing(themeWith({ phoneLayout: "list-row" }), plain());
    expect(document.querySelector(".product-grid")!.getAttribute("data-phone-layout")).toBe("list-row");
  });

  it("keeps merchant phone rows until the shopper chooses Grid", async () => {
    const theme = themeWith({ phoneLayout: "list-row", toolbar: ["grid-list-toggle"] });
    const document = await renderListing(theme, plain());
    expect(document.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");
    expect(document.querySelector(".product-grid")!.getAttribute("data-phone-layout")).toBe("list-row");
    expect(document.querySelector("[data-catalog-view-mobile] [data-view='list']")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-catalog-view-toggle]:not([data-catalog-view-mobile]) [data-view='grid']")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);
  });

  it("shows the phone view switch when a small listing has no sort or filters", async () => {
    const theme = themeWith({ toolbar: ["grid-list-toggle"] });
    const document = await renderListing(theme, {
      ...plain(), products: PRODUCTS.slice(0, 2), pagination: { page: 1, totalPages: 1, total: 2 },
    });
    expect(document.querySelector("#filter-section")).toBeNull();
    expect(document.querySelector("select#sortByMobile")).toBeNull();
    expect(document.querySelector("[data-catalog-phone-bar] [data-catalog-view-toggle]")).not.toBeNull();
  });
});

describe("listing controls", () => {
  it("keeps a tiny listing free of filters it cannot use", async () => {
    const few = (count: number, facets = FACETS) => ({
      ...plain(),
      products: PRODUCTS.slice(0, count),
      facets,
      pagination: { page: 1, totalPages: 1, total: count },
    });
    // Two products: sort only; no filter sidebar or sheet.
    const standard = themeWith({}, STANDARD_CARD);
    const two = await renderListing(standard, few(2));
    expect(two.querySelector("#filter-section")).toBeNull();
    expect(two.querySelector("#mobile-filter-toggle")).toBeNull();
    expect(two.querySelector("select#sortByMobile")).not.toBeNull();
    expect(two.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(gridSizes("grid", standard));
    // Seven products with a facet: below the small-catalogue threshold (8).
    expect((await renderListing(DEFAULT_STOREFRONT_THEME, few(7))).querySelector("#filter-section")).toBeNull();
    // Eight products with nothing that differs between them: still no filters.
    const same = await renderListing(DEFAULT_STOREFRONT_THEME, { ...few(8, []), priceRange: { min: 900, max: 900 } });
    expect(same.querySelector("#filter-section")).toBeNull();
    // Eight products with a facet: filters.
    expect((await renderListing(DEFAULT_STOREFRONT_THEME, few(8))).querySelector("#filter-section")).not.toBeNull();
    // A store below the threshold shows none on any listing, however long.
    const tiny = storeShapeFromFacts({ productCount: 6, skuCount: 6, topCategoryCount: 1, categoryDepth: 1, menu: [], hasCollections: false, hasDeliveryMethods: true });
    expect((await renderListing(DEFAULT_STOREFRONT_THEME, few(8), tiny)).querySelector("#filter-section")).toBeNull();
    // One product: nothing to sort either.
    const one = await renderListing(DEFAULT_STOREFRONT_THEME, few(1));
    expect(one.querySelector("select[data-catalog-sort]")).toBeNull();
  });

  it("offers a page size when there is more than one page, and keeps the chosen size", async () => {
    const theme = themeWith({ toolbar: ["result-count", "sort", "per-page"] });
    const document = await renderListing(theme, plain());
    const select = document.querySelector<HTMLSelectElement>("select#pageSizeDesktop")!;
    expect(select.getAttribute("name")).toBe("limit");
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["20", "40", "60"]);
    const forty = await renderListing(theme, listingProps("https://shop.test/categories/sarees?limit=40"));
    expect(forty.querySelector<HTMLSelectElement>("select#pageSizeDesktop")!.value).toBe("40");
    // The filter form and the page links keep the size.
    expect(forty.querySelector("form input[type='hidden'][name='limit']")!.getAttribute("value")).toBe("40");
    expect(forty.querySelector("nav[aria-label='Pagination'] a[href='/categories/sarees?limit=40&page=2']")).not.toBeNull();
    // One page of products: no page size.
    const small = await renderListing(theme, { ...plain(), pagination: { page: 1, totalPages: 1, total: 20 } });
    expect(small.querySelector("select[name='limit']")).toBeNull();
  });

  it("hides the pieces a template leaves out", async () => {
    const document = await renderListing(themeWith({ toolbar: [] }), plain());
    expect(document.querySelector(".catalog-band-count")).toBeNull();
    expect(document.querySelector("select[name='sortBy']")).toBeNull();
    // Filters still work; applied filters can always be undone.
    expect(document.querySelector("#filter-section")).not.toBeNull();
  });

  it("restores the buyer's grid or list view before the grid paints", async () => {
    const html = await render(LISTING, themeWith({ toolbar: ["sort", "grid-list-toggle"] }), plain(), EMPTY_SLOT);
    const document = parse(html);
    const toggle = document.querySelector("[data-catalog-view-toggle]")!;
    // Painted from the start (no shift when its script runs); removed without JavaScript.
    expect(toggle.hasAttribute("hidden")).toBe(false);
    expect(html).toContain("<noscript><style>[data-catalog-view-toggle] { display: none !important; }</style></noscript>");
    expect(toggle.querySelector("button[data-view='grid']")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");
    // The grid exists when the inline restore runs.
    const restore = [...document.querySelectorAll("script")].find((script) => script.textContent?.includes("localStorage.getItem"))!;
    const frame = restore.previousElementSibling!;
    expect(frame.className).toContain("product-grid-frame");
    const runRestore = (choice: string | null) => {
      new Function("document", "localStorage", restore.textContent!)(
        { currentScript: restore }, { getItem: () => choice },
      );
    };
    runRestore("list");
    expect(frame.getAttribute("data-catalog-results")).toBe("list");
    runRestore("grid");
    expect(frame.getAttribute("data-catalog-results")).toBe("grid");
  });

  it("shows phone aspect chips that open the filter sheet at each facet", async () => {
    const document = await renderListing(themeWith({ toolbar: ["sort", "aspect-chips"] }), plain());
    const chips = Array.from(document.querySelectorAll("a[data-catalog-aspect]"));
    // Origin has one value, so it is no filter and no chip.
    expect(chips.map((chip) => [chip.textContent!.trim(), chip.getAttribute("href")])).toEqual([
      ["Size", "#catalog-facet-size"],
      ["Fabric", "#catalog-facet-fabric"],
      ["Price", "#catalog-facet-price"],
    ]);
    for (const chip of chips) expect(document.querySelector(chip.getAttribute("href")!)!.tagName).toBe("DETAILS");
    // A chip shows how many values of its facet are ticked.
    const selected = await renderListing(themeWith({ toolbar: ["aspect-chips"] }), listingProps("https://shop.test/categories/sarees?size=M&size=S"));
    expect(selected.querySelector("a[href='#catalog-facet-size']")!.textContent).toContain("(2)");
    // Every group carries its anchor, chips or not.
    expect((await renderListing(DEFAULT_STOREFRONT_THEME, plain())).querySelector("#catalog-facet-size")!.tagName).toBe("DETAILS");
  });

  it("links sub-categories and popular filters once the tree and typed specs exist", async () => {
    const theme = themeWith({ toolbar: ["subcategory-pills", "popular-filter-chips", "sort"] });
    const subListings = [
      { id: "c1", label: "Cotton", href: "/categories/cotton" },
      { id: "c2", label: "Silk", href: "/categories/silk" },
    ];
    const document = await renderListing(theme, { ...plain(), subListings }, TREE_STORE_SHAPE);
    expect(Array.from(document.querySelectorAll("nav[aria-label='Sub-categories'] a")).map((link) => link.getAttribute("href")))
      .toEqual(["/categories/cotton", "/categories/silk"]);
    const popular = Array.from(document.querySelectorAll("nav[aria-label='Popular filters'] a"));
    // The values matching most products without matching all of them.
    expect(popular.map((link) => [link.textContent!.trim(), link.getAttribute("href")]).slice(0, 3)).toEqual([
      ["M", "/categories/sarees?size=M"],
      ["S", "/categories/sarees?size=S"],
      ["Fabric 11", "/categories/sarees?fabric=Fabric+11"],
    ]);
    // Today (flat categories, untyped specs) neither renders.
    const today = await renderListing(theme, { ...plain(), subListings });
    expect(today.querySelector("nav[aria-label='Sub-categories']")).toBeNull();
    expect(today.querySelector("nav[aria-label='Popular filters']")).toBeNull();
  });

  it("puts Showcase's saved facet choices before products and marks the active value", async () => {
    const theme = storefrontTemplateTheme("showcase-landing");
    const document = await renderListing(theme, listingProps("https://shop.test/categories/sarees?size=M"));
    const choices = document.querySelector("nav[aria-label='Size choices']")!;
    expect(Array.from(choices.querySelectorAll("a")).map((link) => [link.textContent?.trim(), link.getAttribute("aria-current")])).toEqual([
      ["S", null],
      ["M", "true"],
    ]);
    expect(Boolean(choices.compareDocumentPosition(document.querySelector("[data-catalog-kind='browse']")!) & 4)).toBe(true);
  });

  it("renders Showcase child categories as a segmented strip with an All link", async () => {
    const theme = storefrontTemplateTheme("showcase-landing");
    const props = { ...plain(), subListings: [
      { id: "cotton", label: "Cotton", href: "/categories/cotton" },
      { id: "silk", label: "Silk", href: "/categories/silk" },
    ] };
    const document = await renderListing(theme, props, TREE_STORE_SHAPE);
    const tabs = document.querySelector(".catalog-showcase-tabs")!;
    expect(Array.from(tabs.querySelectorAll("a")).map((link) => [link.textContent?.trim(), link.getAttribute("href")])).toEqual([
      ["All", "/categories/sarees"], ["Cotton", "/categories/cotton"], ["Silk", "/categories/silk"],
    ]);
    expect(tabs.querySelector("a[aria-current='true']")?.textContent?.trim()).toBe("All");
    theme.blocks.listing.toolbar = theme.blocks.listing.toolbar.filter((piece) => piece !== "subcategory-pills");
    expect((await renderListing(theme, props, TREE_STORE_SHAPE)).querySelector(".catalog-showcase-tabs")).toBeNull();
  });
});

describe("facet display types", () => {
  it("paints colour facets as swatches and gives long lists a search field", async () => {
    // Option axes and the brand: the values decide the display.
    const colours = facet("option.colour", "Colour", [["black", 1, "Black"], ["navy", 2, "Navy"], ["off-white", 3, "Off-white"]]);
    const brands = facet("brand", "Brand", Array.from({ length: 14 }, (_, index): [string, number, string] => [`brand-${index + 1}`, 1, `Brand ${index + 1}`]));
    const mixed = facet("option.shade", "Shade", [["black", 1, "Black"], ["rose gold", 1, "Rose Gold"]]);
    const facets = [colours, brands, mixed];
    const document = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), facets });
    const swatches = document.querySelector("fieldset[data-catalog-facet-display='swatch']")!;
    // The label shows; the URL value submits.
    expect(Array.from(swatches.querySelectorAll("input[data-catalog-facet]")).map((input) => input.getAttribute("value")))
      .toEqual(["black", "navy", "off-white"]);
    expect(Array.from(swatches.querySelectorAll("label")).map((label) => label.querySelector("span:not([aria-hidden]):not(.catalog-facet-count)")!.textContent))
      .toEqual(["Black", "Navy", "Off-white"]);
    expect(swatches.querySelector("span[style]")!.getAttribute("style")).toBe("background:#111111");
    // Each swatch keeps its count, which the live count updates.
    expect(swatches.querySelectorAll(".catalog-facet-count")).toHaveLength(3);
    // Fourteen brands: a search field, hidden until its script runs.
    const search = document.querySelector("[data-catalog-facet-search]")!;
    expect(search.hasAttribute("hidden")).toBe(true);
    expect(search.querySelector("input")!.hasAttribute("name")).toBe(false);
    expect(search.closest("details")!.querySelector("summary")!.textContent).toContain("Brand");
    const brandInput = search.closest("fieldset")!.querySelector("input[data-catalog-facet]")!;
    expect([brandInput.getAttribute("name"), brandInput.getAttribute("value")]).toEqual(["brand", "brand-1"]);
    expect(brandInput.closest("label")!.textContent).toContain("Brand 1");
    // One unknown colour keeps the checkbox list.
    expect(document.querySelectorAll("fieldset[data-catalog-facet-display='swatch']")).toHaveLength(1);
  });

  it("follows the merchant's display for typed attributes, painting swatches from the API", async () => {
    const finish = facet("finish", "Finish", [["rose gold", 4, "Rose Gold", "#b76e79"], ["black", 3, "Black"], ["sunset", 2, "Sunset"]], { display: "swatch" });
    // Colour words, but the merchant chose checkboxes; two values, but a searchable list.
    const tone = facet("tone", "Tone", [["black", 1, "Black"], ["navy", 1, "Navy"]]);
    const maker = facet("maker", "Maker", [["a", 1, "A"], ["b", 1, "B"]], { display: "search_list" });
    const document = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), facets: [finish, tone, maker] });
    const swatches = Array.from(document.querySelectorAll("fieldset[data-catalog-facet-display='swatch']"));
    expect(swatches).toHaveLength(1);
    const paints = Array.from(swatches[0]!.querySelectorAll("label > span[aria-hidden]"))
      .map((span) => [span.getAttribute("style"), span.classList.contains("bg-muted")]);
    // The merchant's colour, then the colour word; a value with neither is an empty swatch.
    expect(paints).toEqual([["background:#b76e79", false], ["background:#111111", false], [null, true]]);
    expect(document.querySelectorAll("[data-catalog-facet-search]")).toHaveLength(1);
    expect(document.querySelector("[data-catalog-facet-search]")!.closest("details")!.querySelector("summary")!.textContent).toContain("Maker");
  });

  it("renders a range as From/To number fields in the plain GET form", async () => {
    const document = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), facets: [...FACETS, DISPLAY_SIZE] });
    const form = document.querySelector("form[data-catalog-filters]")!;
    expect(form.getAttribute("method")).toBe("get");
    const range = form.querySelector("fieldset[data-catalog-facet-display='range']")!;
    expect(range.closest("details")!.querySelector("summary")!.textContent).toContain("Display size");
    expect(range.querySelector("legend")!.textContent).toBe("Display size (in)");
    const inputs = Array.from(range.querySelectorAll("input"));
    expect(inputs.map((input) => [
      input.getAttribute("name"),
      input.getAttribute("inputmode"),
      input.getAttribute("placeholder"),
      input.getAttribute("value"),
    ])).toEqual([
      ["display-size.min", "decimal", "11.6", ""],
      ["display-size.max", "decimal", "17.3", ""],
    ]);
    // Each field is labelled (its bound shows as the placeholder), and the unit reads under the pair.
    for (const input of inputs) expect(range.querySelector(`label[for='${input.id}']`)).not.toBeNull();
    expect(Array.from(range.querySelectorAll("label")).map((label) => label.textContent!.trim())).toEqual(["From", "To"]);
    expect(range.querySelector(".catalog-facet-note")!.textContent).toBe("in");
    // Not a count-driven value: the live count never disables it.
    expect(range.querySelector("[data-catalog-facet]")).toBeNull();
    // The desktop sidebar applies it with its own button (a submit of the whole form).
    expect(range.querySelector("button[type='submit']")!.textContent).toContain("Go");
  });

  it("keeps an applied range filled, shown as one removable chip, even when its products no longer differ", async () => {
    const narrowed = { ...DISPLAY_SIZE, range: { min: 13.3, max: 13.3 } };
    const url = "https://shop.test/categories/sarees?display-size.min=13&display-size.max=15.6&size=M";
    const document = await renderListing(
      themeWith({ toolbar: ["sort", "aspect-chips", "applied-chips"] }),
      listingProps(url, {}, [...FACETS, narrowed]),
    );
    const range = document.querySelector("fieldset[data-catalog-facet-display='range']")!;
    expect(Array.from(range.querySelectorAll("input")).map((input) => input.getAttribute("value"))).toEqual(["13", "15.6"]);
    expect(range.closest("details")!.hasAttribute("open")).toBe(true);
    const chips = Array.from(document.querySelectorAll("nav[aria-label='Applied filters'] a[aria-label]"))
      .map((chip) => [chip.textContent!.trim(), chip.getAttribute("href")]);
    expect(chips).toEqual([
      ["Size: M", "/categories/sarees?display-size.max=15.6&display-size.min=13"],
      ["Display size: 13–15.6 in", "/categories/sarees?size=M"],
    ]);
    // The phone aspect chip opens the form at the range.
    expect(document.querySelector("a[data-catalog-aspect][href='#catalog-facet-display-size']")!.textContent).toContain("(1)");
    expect(document.querySelector("#catalog-facet-display-size")!.tagName).toBe("DETAILS");
  });

  it("names applied values and popular filters by their labels", async () => {
    const brand = facet("brand", "Brand", [["samsung", 20, "Samsung"], ["xiaomi", 12, "Xiaomi"], ["apple", 3, "Apple"]]);
    const theme = themeWith({ toolbar: ["popular-filter-chips", "sort", "applied-chips"] });
    const document = await renderListing(
      theme,
      listingProps("https://shop.test/categories/sarees?brand=samsung", {}, [brand, DISPLAY_SIZE]),
      TREE_STORE_SHAPE,
    );
    const chip = document.querySelector("nav[aria-label='Applied filters'] a")!;
    expect([chip.textContent!.trim(), chip.getAttribute("href")]).toEqual(["Brand: Samsung", "/categories/sarees"]);
    // A toolbar without `applied-chips` leaves the chips out (the filter form still undoes each one).
    const without = await renderListing(
      themeWith({ toolbar: ["popular-filter-chips", "sort"] }),
      listingProps("https://shop.test/categories/sarees?brand=samsung", {}, [brand, DISPLAY_SIZE]),
      TREE_STORE_SHAPE,
    );
    expect(without.querySelector("nav[aria-label='Applied filters']")).toBeNull();
    const popular = Array.from(document.querySelectorAll("nav[aria-label='Popular filters'] a"));
    expect(popular.map((link) => [link.textContent!.trim(), link.getAttribute("href")])).toEqual([
      ["Xiaomi", "/categories/sarees?brand=samsung&brand=xiaomi"],
      ["Apple", "/categories/sarees?brand=apple&brand=samsung"],
    ]);
  });
});

describe("filter styles (fidelity slice 3)", () => {
  const FOURTEEN = facet("fabric", "Fabric", Array.from({ length: 14 }, (_, index): [string, number] => [`Fabric ${index + 1}`, 30 - index]));
  const CATEGORY_FACET: ProductFacet = {
    id: "category", name: "Category", slug: "category", kind: "category", display: "checkbox", unit: null, range: null,
    values: [
      { value: "cotton", label: "Cotton", count: 12, swatch: null },
      { value: "silk", label: "Silk", count: 0, swatch: null },
      { value: "linen", label: "Linen", count: 4, swatch: null },
    ],
  };

  it("keeps a ten-group Marketplace filter form compact and functional", async () => {
    const facets = Array.from({ length: 10 }, (_, group) =>
      facet(
        group === 0 ? "brand" : `spec-${group}`,
        group === 0 ? "Brand" : `Specification ${group}`,
        Array.from({ length: 12 }, (_, value): [string, number, string] => [
          `value-${group}-${value}`,
          value + 1,
          `Long value ${group}-${value} with a descriptive label`,
        ]),
      ));
    const html = await render(LISTING, storefrontTemplateTheme("marketplace"), {
      ...listingProps("https://shop.test/categories/sarees", {}, facets),
    }, EMPTY_SLOT, TREE_STORE_SHAPE);
    const aside = parse(html).querySelector("#filter-section")!;
    expect(new TextEncoder().encode(aside.outerHTML).length).toBeLessThan(42_000);
    expect(aside.querySelectorAll("fieldset[data-facet-kind='values']")).toHaveLength(10);
    expect(aside.querySelectorAll("fieldset[data-facet-kind='values'] .catalog-facet-row")).toHaveLength(100);
    expect(aside.querySelectorAll("[data-catalog-facet-row], [data-catalog-facet-label], [data-catalog-facet-count]")).toHaveLength(0);
    expect(aside.querySelector("fieldset[data-facet-kind='values'] .catalog-facet-label")!.textContent).toContain("Long value");
    const form = aside.querySelector("form")!;
    expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual(["get", "/categories/sarees"]);
    expect(form.querySelectorAll("fieldset[data-facet-kind='values'] input[type='checkbox'][name][value]")).toHaveLength(100);
  });

  it("the dense column carries Amazon's numbers, sends ten values per group and fetches the rest on See more", async () => {
    const theme = storefrontTemplateTheme("marketplace");
    const document = await renderListing(theme, { ...plain(), facets: [FOURTEEN, ...FACETS.slice(0, 1)] }, TREE_STORE_SHAPE);
    const column = document.querySelector("#filter-section")!;
    expect(column.getAttribute("data-placement")).toBe("sidebar");
    expect(column.getAttribute("style")).toBe("--catalog-filter-column:262px;--catalog-filter-row:24px;--catalog-filter-label:14px");
    const form = column.querySelector("form")!;
    expect(form.getAttribute("data-filter-style")).toBe("sidebar-dense");
    // No in-listing search field in the dense column (the header searches).
    expect(form.querySelector("input[type='search'][name='q']")).toBeNull();
    const fabric = form.querySelector("#catalog-facet-fabric")!;
    expect(fabric.hasAttribute("open")).toBe(true);
    expect(fabric.querySelectorAll("input[data-catalog-facet]")).toHaveLength(10);
    const more = fabric.querySelector("a[data-catalog-facet-more]")!;
    expect([more.textContent!.trim(), more.getAttribute("href")]).toEqual(["See more (4)", "/categories/sarees?showAll=fabric"]);
    // A long list gets its search field (hidden until its script runs).
    expect(fabric.querySelector("[data-catalog-facet-search]")!.hasAttribute("hidden")).toBe(true);
    // Availability: exclude sold out, on sale, free delivery, as plain checkboxes.
    expect(Array.from(form.querySelectorAll("#catalog-facet-availability input")).map((input) => input.getAttribute("name")))
      .toEqual(["inStock", "hasDiscount", "freeDelivery"]);

    // Without JavaScript, See more renders every value; its link folds them back.
    const all = await renderListing(theme, { ...listingProps("https://shop.test/categories/sarees?showAll=fabric", {}, [FOURTEEN, ...FACETS.slice(0, 1)]) }, TREE_STORE_SHAPE);
    const expanded = all.querySelector("#catalog-facet-fabric")!;
    expect(expanded.querySelectorAll("input[data-catalog-facet]")).toHaveLength(14);
    const less = expanded.querySelector("a[data-catalog-facet-more]")!;
    expect([less.textContent!.trim(), less.getAttribute("href"), less.getAttribute("aria-expanded")]).toEqual(["See less", "/categories/sarees", "true"]);
  });

  it("marketplace phones get one scrolling filter row and a split rail over the same GET form", async () => {
    const document = await renderListing(storefrontTemplateTheme("marketplace"), plain(), TREE_STORE_SHAPE);
    const bar = document.querySelector("[data-catalog-phone-bar]")!;
    expect(bar.className).toContain("catalog-marketplace-phone-bar");
    expect(bar.querySelectorAll(".catalog-marketplace-phone-controls")).toHaveLength(1);
    expect(bar.querySelector("#mobile-filter-toggle[aria-controls='filter-section']")!.textContent).toContain("Filters");
    expect(bar.querySelector("#sortByMobile")!.closest("label")!.nextElementSibling!.matches("[data-catalog-view-toggle]")).toBe(true);
    const controls = Array.from(bar.querySelectorAll(".catalog-marketplace-phone-controls > *"));
    expect(controls.indexOf(bar.querySelector("[data-catalog-view-toggle]")!))
      .toBeLessThan(controls.indexOf(bar.querySelector(".catalog-marketplace-quick-filter")!));
    expect(Array.from(bar.querySelectorAll(".catalog-marketplace-quick-filter")).map((link) => link.getAttribute("href")))
      .toEqual(["/categories/sarees?hasDiscount=true", "/categories/sarees?freeDelivery=true"]);
    expect(bar.querySelector(".catalog-marketplace-phone-controls a[href='#catalog-facet-size']")).not.toBeNull();
    const rail = document.querySelector("#filter-section[data-marketplace-filter-rail]")!;
    const form = rail.querySelector("form")!;
    expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual(["get", "/categories/sarees"]);
    expect(form.querySelectorAll("details[data-catalog-mobile-facet]").length).toBeGreaterThan(0);
    expect(form.querySelector("#catalog-facet-size input[name='size']")).not.toBeNull();
  });

  it("Dawn's bar puts the facets in dropdowns over a full-width grid, four in the bar and the rest behind More filters", async () => {
    const colour = facet("colour", "Colour", [["Red", 4], ["Blue", 3]]);
    const document = await renderListing(storefrontTemplateTheme("boutique"), { ...plain(), facets: [...FACETS, colour] }, TREE_STORE_SHAPE);
    const form = document.querySelector("form[data-catalog-filters]")!;
    expect(form.getAttribute("data-placement")).toBe("bar");
    const dropdowns = Array.from(form.querySelectorAll("details[data-catalog-dropdown]"));
    expect(dropdowns.map((dropdown) => dropdown.querySelector("summary")!.textContent!.trim())).toEqual(["Availability", "Price", "Size", "Fabric", "Colour"]);
    expect(dropdowns.every((dropdown) => !dropdown.hasAttribute("open"))).toBe(true);
    expect(dropdowns.slice(0, 4).some((dropdown) => dropdown.hasAttribute("data-bar-overflow"))).toBe(false);
    expect(dropdowns.slice(4).every((dropdown) => dropdown.hasAttribute("data-bar-overflow"))).toBe(true);
    expect(form.querySelector("button[data-catalog-bar-more]")!.textContent!.trim()).toBe(`More filters (${dropdowns.length - 4})`);
    // The bar sits above the grid (no column beside it).
    expect(document.querySelector("[data-catalog-layout]")!.getAttribute("data-catalog-layout")).toBe("bar");
  });

  it("keeps boutique counts with the desktop and phone controls only for its bar layout", async () => {
    const theme = storefrontTemplateTheme("boutique");
    const category = await renderListing(theme, { ...plain(), kind: "category" }, TREE_STORE_SHAPE);
    expect(category.querySelector("[data-catalog-band][data-boutique-bar]")).not.toBeNull();
    expect(category.querySelector(".catalog-band-heading .catalog-band-count")).toBeNull();
    expect(category.querySelector(".catalog-band-tools .catalog-band-count")!.textContent).toBe("50 products");
    expect(category.querySelector(".catalog-boutique-phone-bar .catalog-band-count")!.textContent).toBe("50 products");
    expect(category.querySelector(".catalog-boutique-phone-bar #mobile-filter-toggle")!.getAttribute("aria-controls")).toBe("filter-section");
    expect(category.querySelector(".catalog-boutique-phone-bar select[name='sortBy']")).not.toBeNull();

    const search = await renderListing(theme, { ...listingProps("https://shop.test/search?q=linen"), kind: "search" }, TREE_STORE_SHAPE);
    expect(search.querySelector("[data-catalog-band][data-boutique-bar] h1")!.textContent).toBe("Sarees");
    expect(search.querySelector(".catalog-band-tools .catalog-band-count")!.textContent).toBe("50 products");

    theme.blocks.listing.filters = { style: "sidebar-comfortable", openByDefault: true, searchPlacement: "same", ruled: false };
    const sidebar = await renderListing(theme, { ...plain(), kind: "category" }, TREE_STORE_SHAPE);
    expect(sidebar.querySelector("[data-boutique-bar], [data-catalog-boutique]")).toBeNull();
    expect(sidebar.querySelector(".catalog-band-heading .catalog-band-count")!.textContent).toBe("50 products");
  });

  it("links the category tree with counts, carrying the buyer's filters, and moves it to pills when the template has them", async () => {
    const url = "https://shop.test/categories/sarees?size=M&page=2";
    const props = listingProps(url, {}, [CATEGORY_FACET, ...FACETS]);
    const document = await renderListing(DEFAULT_STOREFRONT_THEME, props, TREE_STORE_SHAPE);
    const group = document.querySelector("#catalog-facet-category")!;
    const text = (row: Element, part: string) => row.querySelector(`.catalog-facet-${part}`)!.textContent;
    expect(Array.from(group.querySelectorAll("a.catalog-facet-row")).map((link) => [text(link, "label"), text(link, "count"), link.getAttribute("href")]))
      .toEqual([["Cotton", "12", "/categories/cotton?size=M"], ["Linen", "4", "/categories/linen?size=M"]]);
    // A sub-category the filters empty is text, not a dead link.
    expect(group.querySelector("span.catalog-facet-row")!.textContent).toContain("Silk");
    // Category values are never a filter input.
    expect(document.querySelector("input[name='category']")).toBeNull();

    const subListings = [
      { id: "c1", label: "Cotton", href: "/categories/cotton" },
      { id: "c2", label: "Silk", href: "/categories/silk" },
      { id: "c3", label: "Linen", href: "/categories/linen" },
      { id: "c4", label: "Muslin", href: "/categories/muslin" },
    ];
    const pills = await renderListing(
      themeWith({ toolbar: ["breadcrumb", "subcategory-pills", "result-count", "sort"] }),
      { ...listingProps("https://shop.test/categories/sarees", {}, [CATEGORY_FACET, ...FACETS]), subListings },
      TREE_STORE_SHAPE,
    );
    // Children that still list products (the facet counts them) become pills; the column drops its category group.
    expect(Array.from(pills.querySelectorAll("nav[aria-label='Sub-categories'] a")).map((link) => link.getAttribute("href")))
      .toEqual(["/categories/cotton", "/categories/linen"]);
    expect(pills.querySelector("#catalog-facet-category")).toBeNull();
  });

  it("merges an option axis and an attribute of the same name into one group", async () => {
    const option = facet("option.ram", "RAM", [["8gb", 5, "8GB"], ["16gb", 3, "16GB"]]);
    const attribute = facet("ram", "RAM", [["8gb", 9, "8GB"], ["4gb", 2, "4GB"]]);
    const document = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), facets: [option, attribute] });
    const groups = Array.from(document.querySelectorAll("details")).filter((details) => details.querySelector("summary span")!.textContent === "RAM");
    expect(groups).toHaveLength(1);
    expect(Array.from(groups[0]!.querySelectorAll("input[data-catalog-facet]")).map((input) => `${input.getAttribute("name")}=${input.getAttribute("value")}`))
      .toEqual(["option.ram=8gb", "option.ram=16gb", "ram=4gb"]);
  });

  it("honours the listing's own listing_template", async () => {
    const list = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), listingTemplate: "list" });
    expect(list.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    const drawer = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), listingTemplate: "drawer" });
    expect(drawer.querySelector("#filter-section")!.getAttribute("data-catalog-dialog")).toBe("drawer");
    // Unknown ids keep the theme's listing.
    const unknown = await renderListing(DEFAULT_STOREFRONT_THEME, { ...plain(), listingTemplate: "spec-grid" });
    expect(unknown.querySelector("#filter-section")!.getAttribute("data-placement")).toBe("sidebar");
  });

  it("lets merchants with a filter drawer choose sticky category sidebars without losing their four-column cap", async () => {
    const theme = pillRowListingTheme();
    const defaultPage = await renderListing(theme, { ...plain(), kind: "category" });
    expect(defaultPage.querySelector("#filter-section")!.getAttribute("data-catalog-dialog")).toBe("drawer");
    expect(defaultPage.querySelector(".product-grid-frame")!.getAttribute("data-catalog-grid-columns")).toBe("4");

    theme.blocks.listing.filters = { style: "sidebar-dense", openByDefault: true, searchPlacement: "same", ruled: false };
    const sidebarPage = await renderListing(theme, { ...plain(), kind: "category" });
    expect(sidebarPage.querySelector("[data-catalog-kind='category'][data-catalog-layout='sidebar'] > #filter-section")).not.toBeNull();
    expect(sidebarPage.querySelector(".product-grid-frame")!.getAttribute("data-catalog-grid-columns")).toBe("4");
  });

  it("shows categories as cards and searches as rows with a view choice when the merchant asks for it", async () => {
    const theme = pillRowListingTheme();
    const page = await renderListing(theme, { ...plain(), kind: "category" });
    expect(page.querySelector(".product-grid")!.hasAttribute("data-phone-layout")).toBe(false);
    expect(page.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");
    expect(page.querySelectorAll("[data-catalog-view-toggle]")).toHaveLength(2);
    expect(page.querySelector("[data-catalog-view-mobile] [data-view='grid']")!.getAttribute("aria-pressed")).toBe("true");

    const search = await renderListing(theme, { ...listingProps("https://shop.test/search?q=linen"), kind: "search" });
    expect(search.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    expect(search.querySelector("[data-catalog-view-mobile] [data-view='list']")!.getAttribute("aria-pressed")).toBe("true");

    theme.blocks.listing.phoneLayout = "list-row";
    const rows = await renderListing(theme, { ...plain(), kind: "category" });
    const rowGrid = rows.querySelector(".product-grid")!;
    expect(rowGrid.getAttribute("data-phone-layout")).toBe("list-row");
    const restore = [...rows.querySelectorAll("script")].find((script) => script.textContent?.includes("localStorage.getItem"))!;
    new Function("document", "localStorage", restore.textContent!)(
      { currentScript: restore }, { getItem: () => "grid" },
    );
    expect(rowGrid.hasAttribute("data-phone-layout")).toBe(false);
    expect(rows.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");

    theme.blocks.listing.searchLayout = "grid";
    const merchantSearch = await renderListing(theme, { ...listingProps("https://shop.test/search?q=linen"), kind: "search" });
    expect(merchantSearch.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");

    theme.blocks.listing.toolbar = theme.blocks.listing.toolbar.filter((item) => item !== "grid-list-toggle");
    const merchantOnly = await renderListing(theme, { ...plain(), kind: "category" });
    expect(merchantOnly.querySelector(".product-grid")!.getAttribute("data-phone-layout")).toBe("list-row");
    expect(merchantOnly.querySelector("[data-catalog-view-toggle]")).toBeNull();
  });

  it("shows child categories as pills when the listing has published children", async () => {
    const page = await renderListing(ruledRailListingTheme(), {
      ...plain(), kind: "category",
      subListings: [
        { id: "cotton", label: "Cotton", href: "/categories/cotton" },
        { id: "silk", label: "Silk", href: "/categories/silk" },
      ],
    }, TREE_STORE_SHAPE);
    expect(Array.from(page.querySelectorAll("nav[aria-label='Sub-categories'] a")).map((link) => link.textContent!.trim()))
      .toEqual(["Cotton", "Silk"]);
  });

  it("puts truthful phone filters, sort, and popular values in one scroll row with the pill-row phone bar", async () => {
    const theme = pillRowListingTheme();
    for (const [kind, url] of [
      ["category", "https://shop.test/categories/sarees"],
      ["search", "https://shop.test/search?q=linen&hasDiscount=true"],
    ] as const) {
      const document = await renderListing(theme, { ...listingProps(url), kind }, TREE_STORE_SHAPE);
      const bar = document.querySelector("[data-catalog-phone-bar]")!;
      expect(bar.className).toContain("catalog-mass-retail-phone-bar");
      expect(bar.className).toContain("overflow-x-auto");
      expect(bar.querySelector("#mobile-filter-toggle[aria-controls='filter-section']")).not.toBeNull();
      expect(bar.querySelector("select#sortByMobile")).not.toBeNull();
      const phoneChips = bar.querySelector("nav[aria-label='Product filters']")!;
      expect(phoneChips.className).not.toContain("overflow-x-auto");
      expect(Array.from(phoneChips.querySelectorAll("a")).map((link) => link.textContent!.trim())).toEqual(
        expect.arrayContaining(["On sale", "Free delivery", "M"]),
      );
      expect(document.querySelector("nav[aria-label='Popular filters']")!.className).toContain("catalog-mass-retail-desktop-chips");
      if (kind === "search") {
        expect(phoneChips.querySelector("a[aria-current='true']")!.textContent).toContain("On sale");
        expect(phoneChips.querySelector("a[href*='q=linen']")).not.toBeNull();
      }
    }
  });

  it("sets no column cap from the card: only the merchant's Max columns caps the grid", async () => {
    const theme = storefrontTemplateTheme("department-mall");
    const page = await renderListing(theme, { ...plain(), kind: "category" });
    const frame = page.querySelector(".product-grid-frame")!;
    expect(frame.hasAttribute("data-catalog-card")).toBe(false);
    expect(frame.hasAttribute("data-catalog-grid-columns")).toBe(false);
    theme.blocks.listing.maxColumns = 4;
    const capped = await renderListing(theme, { ...plain(), kind: "category" });
    expect(capped.querySelector(".product-grid-frame")!.getAttribute("data-catalog-grid-columns")).toBe("4");
    expect(capped.querySelector(".product-grid-frame")!.hasAttribute("data-catalog-card")).toBe(false);
  });

  it("renders the one card for every facts and action setting on a listing, under one visually hidden Products heading", async () => {
    for (const facts of ["none", "key-specs", "swatches", "delivery"] as const) {
      for (const action of ["none", "quick-add", "full"] as const) {
        const card = { variant: "standard", settings: { facts, action, hoverImage: false } } as StorefrontThemeBlocks["card"];
        const page = await renderListing(themeWith({}, card), plain());
        const cards = page.querySelectorAll("[data-theme-component='product-card']");
        expect(cards.length, `${facts}/${action}`).toBe(PRODUCTS.length);
        expect(cards[0]!.getAttribute("data-action")).toBe(action);
        expect(cards[0]!.hasAttribute("data-card-variant")).toBe(false);
        const frame = page.querySelector(".product-grid-frame")!;
        const heading = frame.previousElementSibling!;
        expect(heading.tagName).toBe("H2");
        expect(heading.className).toBe("sr-only");
        expect(heading.textContent!.trim()).toBe("Products");
        expect(Array.from(cards).every((node) => node.querySelector(".product-card-name")!.tagName === "H3")).toBe(true);
      }
    }
  });

  it("opens with one compact band: breadcrumb, h1 at the theme's title size, count and sort", async () => {
    const document = await renderListing(specListingTheme(), {
      ...plain(),
      band: { title: "Laptop", breadcrumb: [{ label: "Home", href: "/" }, { label: "Computers", href: "/categories/computers" }], countLabel: "3,780 products" },
      subListings: [{ id: "gaming", label: "Gaming Laptop", href: "/categories/gaming" }, { id: "ultrabook", label: "Premium Ultrabook", href: "/categories/ultrabook" }],
    }, TREE_STORE_SHAPE);
    const band = document.querySelector("[data-catalog-band]")!;
    const breadcrumb = document.querySelector("nav[aria-label='Breadcrumb']")!;
    const pills = document.querySelector("nav[aria-label='Sub-categories']")!;
    const phoneBar = document.querySelector("[data-catalog-phone-bar]")!;
    expect(band.querySelector("h1")!.className).toBe("catalog-band-title");
    expect(band.hasAttribute("data-visible-breadcrumb")).toBe(true);
    expect(Array.from(breadcrumb.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual(["/", "/categories/computers"]);
    expect(breadcrumb.querySelector("[aria-current='page']")!.textContent).toBe("Laptop");
    expect(breadcrumb.compareDocumentPosition(pills) & 4).toBe(4);
    expect(pills.compareDocumentPosition(phoneBar) & 4).toBe(4);
    expect(band.closest("[data-catalog-layout='sidebar'] > .min-w-0")).not.toBeNull();
    expect(band.querySelector(".catalog-band-count")!.textContent).toBe("3,780 products");
    expect(band.querySelector("select#sortByDesktop")).not.toBeNull();
    expect(band.querySelector("select#pageSizeDesktop")).not.toBeNull();
    // Nothing sits between the band and the results but the pills and the filters.
    expect(document.body.textContent).not.toContain("Showing 20 of");
  });

  it("keeps the normal toolbar when a merchant changes the beside-filters band's filters to a bar", async () => {
    const theme = specListingTheme();
    theme.blocks.listing.filters = { style: "bar-dropdowns", openByDefault: false, searchPlacement: "same", ruled: false };
    const document = await renderListing(theme, plain(), TREE_STORE_SHAPE);
    const band = document.querySelector("[data-catalog-band]")!;
    expect(band.querySelector("nav[aria-label='Breadcrumb']")).not.toBeNull();
    expect(band.closest("[data-catalog-layout]")).toBeNull();
  });

  it("keeps the spec category title visible on phones when breadcrumbs are disabled", async () => {
    const theme = specListingTheme();
    theme.blocks.listing.toolbar = theme.blocks.listing.toolbar.filter((piece) => piece !== "breadcrumb");
    const document = await renderListing(theme, { ...plain(), kind: "category" }, TREE_STORE_SHAPE);
    const band = document.querySelector(".catalog-spec-results-band")!;
    expect(document.querySelector("nav[aria-label='Breadcrumb']")!.className).toContain("sr-only");
    expect(band.hasAttribute("data-visible-breadcrumb")).toBe(false);
    expect(band.querySelector("h1")!.textContent).toBe("Sarees");
  });

  it("offers matching search categories as wrapped pills without hiding the remaining facet", async () => {
    const document = await renderListing(specListingTheme(), {
      ...listingProps("https://shop.test/search?q=linen", {}, [CATEGORY_FACET, ...FACETS]),
      kind: "search",
    }, TREE_STORE_SHAPE);
    const pills = document.querySelector("nav[aria-label='Categories'].catalog-spec-pills")!;
    expect(Array.from(pills.querySelectorAll("a")).map((link) => [link.textContent!.trim(), link.getAttribute("href")]))
      .toEqual([["Cotton", "/categories/cotton?q=linen"], ["Linen", "/categories/linen?q=linen"]]);
    expect(document.querySelector("#catalog-facet-category")).not.toBeNull();
    expect(pills.compareDocumentPosition(document.querySelector("[data-catalog-layout]")!) & 4).toBe(4);

    const noCategoryFacet = await renderListing(specListingTheme(), {
      ...listingProps("https://shop.test/search?q=linen"),
      kind: "search",
      band: { title: "Search results", countLabel: "50 results for linen" },
    }, TREE_STORE_SHAPE);
    expect(noCategoryFacet.querySelector("nav[aria-label='Categories']")).toBeNull();
    const heading = noCategoryFacet.querySelector(".catalog-spec-results-band[data-catalog-kind='search'] h1")!;
    expect(heading.textContent).toBe("Search results");
    expect(heading.closest(".catalog-band")!.textContent).toContain("50 results for linen");
  });

  it("gives spec search the full five-card width while preserving merchant views and filter controls", async () => {
    const theme = specListingTheme();
    const search = { ...listingProps("https://shop.test/search?q=linen", {}, [CATEGORY_FACET, ...FACETS]), kind: "search" as const };
    const defaultPage = await renderListing(theme, search, TREE_STORE_SHAPE);
    expect(defaultPage.querySelector("[data-catalog-kind='search'][data-catalog-layout='drawer']")).not.toBeNull();
    expect(defaultPage.querySelector(".product-grid-frame")!.getAttribute("data-catalog-grid-columns")).toBe("5");
    expect(defaultPage.querySelector(".catalog-spec-results-band [data-catalog-filter-toggle][aria-controls='filter-section']")).not.toBeNull();
    expect(defaultPage.querySelector("#filterForm")!.getAttribute("data-placement")).toBe("drawer");

    const category = await renderListing(theme, { ...plain(), kind: "category" }, TREE_STORE_SHAPE);
    expect(category.querySelector("[data-catalog-kind='category'][data-catalog-layout='sidebar']")).not.toBeNull();
    expect(category.querySelector(".product-grid-frame")!.hasAttribute("data-catalog-grid-columns")).toBe(false);

    theme.blocks.listing.searchLayout = "list";
    theme.blocks.listing.toolbar.push("grid-list-toggle");
    const list = await renderListing(theme, search, TREE_STORE_SHAPE);
    expect(list.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    expect(list.querySelector("[data-catalog-view-toggle]")).not.toBeNull();

    theme.blocks.listing.filters = { style: "sidebar-comfortable", openByDefault: true, searchPlacement: "same", ruled: false };
    const sidebar = await renderListing(theme, search, TREE_STORE_SHAPE);
    expect(sidebar.querySelector("[data-catalog-kind='search'][data-catalog-layout='sidebar'] > #filter-section")).not.toBeNull();
    expect(sidebar.querySelector(".product-grid-frame")!.hasAttribute("data-catalog-grid-columns")).toBe(false);
  });

  it("bounds spec search phone chips and leaves only real refinements above products", async () => {
    const theme = specListingTheme();
    const facets = [CATEGORY_FACET, ...FACETS];
    const search = { ...listingProps("https://shop.test/search?q=laptop&size=M&hasDiscount=true", {}, facets), kind: "search" as const };
    const page = await renderListing(theme, search, TREE_STORE_SHAPE);
    const pills = page.querySelector("nav[aria-label='Categories']")!;
    expect(pills.className).toContain("catalog-spec-search-pills");
    expect(pills.querySelectorAll("a")).toHaveLength(CATEGORY_FACET.values.filter(({ count }) => count > 0).length);
    expect(page.querySelector(".catalog-spec-results-band")!.hasAttribute("data-spec-search")).toBe(true);
    expect(page.querySelector("[data-catalog-phone-bar] #mobile-filter-toggle")).not.toBeNull();
    expect(page.querySelector("[data-catalog-phone-bar] #sortByMobile")).not.toBeNull();
    const applied = page.querySelector("nav[aria-label='Applied filters']")!;
    expect(applied.textContent).toContain("Size: M");
    expect(applied.textContent).toContain("On sale");
    expect(applied.textContent).not.toContain("Search:");

    theme.blocks.header = { variant: "inline-nav", settings: { search: "icon", rowTone: "page", cartTotal: false } };
    const alternateHeader = await renderListing(theme, search, TREE_STORE_SHAPE);
    expect(alternateHeader.querySelector("nav[aria-label='Applied filters']")!.textContent).toContain("Search:");
  });

  it("puts price first only where the merchant's group order says so", async () => {
    const names = (document: Document) => Array.from(document.querySelectorAll("#filterForm .catalog-filter-groups > details > summary > span:first-child"))
      .map((span) => span.textContent!.trim());
    const spec = specListingTheme();
    expect(names(await renderListing(spec, plain(), TREE_STORE_SHAPE)).slice(0, 3)).toEqual(["Price", "Availability", "Size"]);
    expect(names(await renderListing(storefrontTemplateTheme("marketplace"), plain(), TREE_STORE_SHAPE)).slice(0, 3))
      .toEqual(["Availability", "Size", "Fabric"]);
    expect(names(await renderListing(storefrontTemplateTheme("department-mall"), plain(), TREE_STORE_SHAPE)).slice(0, 3))
      .toEqual(["Availability", "Size", "Fabric"]);
    spec.blocks.listing.filters = { style: "bar-dropdowns", openByDefault: false, searchPlacement: "same", ruled: false };
    expect(names(await renderListing(spec, plain(), TREE_STORE_SHAPE)).slice(0, 3)).toEqual(["Availability", "Price", "Size"]);
  });

  it("uses the merchant's group order while keeping facet order and omitting absent groups", async () => {
    const theme = comfortableListingTheme();
    theme.blocks.listing.filters.order = ["other", "price", "category", "availability", "brand", "rating"];
    const brand = facet("brand", "Brand", [["samsung", 8], ["apple", 5]]);
    const page = { ...plain(), facets: [CATEGORY_FACET, brand, ...FACETS] };
    const document = await renderListing(theme, page, TREE_STORE_SHAPE);
    const names = (document: Document) => Array.from(document.querySelectorAll("#filterForm .catalog-filter-groups > details > summary > span:first-child"))
      .map((span) => span.textContent!.trim());
    expect(names(document)).toEqual(["Size", "Fabric", "Price", "Category", "Availability", "Brand"]);
    const search = await renderListing(theme, {
      ...listingProps("https://shop.test/search?q=phone", { kind: "search" }, [brand, ...FACETS]),
      kind: "search",
    }, TREE_STORE_SHAPE);
    expect(names(search)).toEqual(["Size", "Fabric", "Price", "Availability", "Brand"]);
  });

  it("offers a saved category group in the filter bar without changing its template default", async () => {
    const theme = storefrontTemplateTheme("boutique");
    const page = { ...plain(), facets: [CATEGORY_FACET, ...FACETS] };
    const names = (document: Document) => Array.from(document.querySelectorAll("#filterForm .catalog-filter-groups > details > summary > span:first-child"))
      .map((span) => span.textContent!.trim());
    expect(names(await renderListing(theme, page, TREE_STORE_SHAPE))).not.toContain("Category");
    theme.blocks.listing.filters.order = ["category", "availability", "price", "rating", "brand", "other"];
    expect(names(await renderListing(theme, page, TREE_STORE_SHAPE)).slice(0, 3)).toEqual(["Category", "Availability", "Price"]);
  });

  it("shows buying filters before category links in a price-first comfortable rail", async () => {
    const names = (document: Document) => Array.from(document.querySelectorAll("#filterForm .catalog-filter-groups > details > summary > span:first-child"))
      .map((span) => span.textContent!.trim());
    const theme = comfortableListingTheme();
    const page = { ...plain(), facets: [CATEGORY_FACET, ...FACETS] };
    const comfortable = names(await renderListing(theme, page, TREE_STORE_SHAPE));
    expect(comfortable.slice(0, 3)).toEqual(["Price", "Availability", "Size"]);
    expect(comfortable.at(-1)).toBe("Category");
    theme.blocks.listing.filters = { style: "sidebar-dense", openByDefault: true, searchPlacement: "same", ruled: false };
    expect(names(await renderListing(theme, page, TREE_STORE_SHAPE))[0]).toBe("Availability");
  });
});

describe("paging", () => {
  it("load more links the next page and reports progress; later pages link back", async () => {
    const theme = themeWith({ paging: "load-more" });
    const document = await renderListing(theme, plain());
    const paging = document.querySelector("[data-catalog-paging='load-more']")!;
    expect(paging.querySelector("a[data-catalog-load-more]")!.getAttribute("href")).toBe("/categories/sarees?page=2");
    expect(paging.querySelector("[data-catalog-progress]")!.textContent!.trim()).toBe("Showing 1–20 of 50 products");
    expect(document.querySelector("nav[aria-label='Pagination']")).toBeNull();
    expect(document.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("grid");

    const last = await renderListing(theme, { ...listingProps("https://shop.test/categories/sarees?page=3"), products: PRODUCTS.slice(0, 10) });
    expect(last.querySelector("a[data-catalog-load-more]")).toBeNull();
    expect(last.querySelector("[data-catalog-progress]")!.textContent!.trim()).toBe("Showing 41–50 of 50 products");
    expect(last.querySelector("a[href='/categories/sarees?page=2']")!.textContent).toContain("Show previous products");
  });

  it("infinite scroll is numbered pagination until its script takes over", async () => {
    const document = await renderListing(themeWith({ paging: "infinite" }), plain());
    const paging = document.querySelector("[data-catalog-paging='infinite']")!;
    expect(paging.querySelector("nav[aria-label='Pagination'] a[href='/categories/sarees?page=2']")).not.toBeNull();
    const loader = paging.querySelector("[data-catalog-load-more-block]")!;
    expect(loader.hasAttribute("hidden")).toBe(true);
    expect(loader.querySelector("a[data-catalog-load-more]")!.getAttribute("href")).toBe("/categories/sarees?page=2");
  });
});

describe("listing page", () => {
  const categoryPage = (theme: StorefrontThemeDocument) =>
    render(PAGE, theme, {
      kind: "category",
      hero: { title: "Sarees", description: "<p>Handwoven.</p>", count: 50, banner: { src: "https://cdn.shop.test/c.jpg", alt: "" } },
      listing: plain(),
      content: { html: "<h2>Buying guide</h2><p>Cotton breathes.</p>", label: "Sarees guide" },
      data: { "data-category-name": "Sarees" },
    }, EMPTY_SLOT).then(parse);

  it("renders the category header, listing and guide in one body", async () => {
    const document = await categoryPage(DEFAULT_STOREFRONT_THEME);
    expect(duplicateIds(document)).toEqual([]);
    expect(document.querySelector("[data-category-name='Sarees']")).not.toBeNull();
    expect(document.querySelector("h1")!.textContent!.trim()).toBe("Sarees");
    const breadcrumb = document.querySelector("nav:has(ol)")!;
    expect(breadcrumb.className).not.toContain("sr-only");
    expect(document.body.textContent).toContain("50 products");
    expect(document.querySelector("section[aria-label='Sarees guide'] h2")!.textContent).toBe("Buying guide");
    expect(document.querySelector("#filter-section")).not.toBeNull();
    // The default template has no category banner.
    expect(document.querySelector("img[data-catalog-banner]")).toBeNull();
  });

  it("places the short description above products while the buying guide stays below", async () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.blocks.listing.descriptionPlacement = "above";
    const document = await categoryPage(theme);
    const title = document.querySelector("h1")!;
    const description = document.querySelector("[data-catalog-content='above']")!;
    const product = document.querySelector("[data-theme-component='product-card']")!;
    const guide = document.querySelector("[data-catalog-content='below']")!;
    expect(title.compareDocumentPosition(description) & 4).toBeTruthy();
    expect(description.compareDocumentPosition(product) & 4).toBeTruthy();
    expect(product.compareDocumentPosition(guide) & 4).toBeTruthy();
    expect(description.textContent).toContain("Handwoven.");
    expect(guide.textContent).toContain("Buying guide");
  });

  it("shows the banner and hides the breadcrumb visually when the template says so", async () => {
    const document = await categoryPage(themeWith({ toolbar: ["category-banner", "sort"] }));
    const banner = document.querySelector("img[data-catalog-banner]")!;
    expect(banner.getAttribute("fetchpriority")).toBe("high");
    expect([banner.getAttribute("width"), banner.getAttribute("height")]).toEqual(["1344", "296"]);
    const breadcrumb = document.querySelector("nav:has(ol)")!;
    // Still read by assistive technology (it matches the BreadcrumbList JSON-LD).
    expect(breadcrumb.className).toContain("sr-only");
    expect(breadcrumb.getAttribute("aria-label")).toBe("Breadcrumb");
  });

  it("keeps category banners off phone listings when the merchant turns the phone banner off", async () => {
    const document = await categoryPage(comfortableListingTheme());
    const banner = document.querySelector("img[data-catalog-banner]")!;
    expect(banner.className).toContain("hidden sm:block");
  });

  it("renders every template's listing without duplicate ids", async () => {
    for (const id of ["boutique", "marketplace", "department-mall", "daily-essentials", "showcase-landing"] as const) {
      const document = parse(await render(PAGE, storefrontTemplateTheme(id), { kind: "search", hero: { title: "Search results", count: 50 }, listing: plain() }, EMPTY_SLOT, TREE_STORE_SHAPE));
      expect(duplicateIds(document), id).toEqual([]);
      expect(document.querySelectorAll("[data-theme-component='product-card']").length, id).toBeGreaterThan(0);
      if (id === "boutique") expect(document.querySelector(".min-h-screen")!.classList.contains("bg-background")).toBe(true);
      // One card in every preset: no per-site card marks on the page.
      expect(document.querySelector("[data-catalog-card], [data-card-variant]"), id).toBeNull();
      expect(document.querySelectorAll("h2.sr-only").length, id).toBeGreaterThan(0);
    }
  });

  it("keeps a merchant's filter-style override on a ruled rail", async () => {
    const theme = ruledRailListingTheme();
    theme.blocks.listing.filters = { style: "sidebar-dense", openByDefault: true, searchPlacement: "same", ruled: false };
    const document = await categoryPage(theme);
    expect(document.querySelector("[data-catalog-rail='fashion']")).toBeNull();
    // The pinned phone row is its own choice (`phoneBar`), kept with any facet style.
    expect(document.querySelector("[data-catalog-fashion-phone-bar]")).not.toBeNull();
    expect(document.querySelector("[data-filter-style='sidebar-dense']")).not.toBeNull();
    theme.blocks.listing.phoneBar = "standard";
    expect((await categoryPage(theme)).querySelector("[data-catalog-fashion-phone-bar]")).toBeNull();
  });
});
