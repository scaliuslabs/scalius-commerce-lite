// @vitest-environment node
/**
 * Render-only listing coverage (no browser): renders the real catalog Astro
 * components with Astro's container API for every listing layout, toolbar
 * piece, phone layout and paging mode, and checks the markup each promises.
 * The default layout (sidebar-grid) must render exactly the markup it
 * rendered before the listing templates (the baselines in __fixtures__).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import {
  DEFAULT_STOREFRONT_THEME,
  storeShapeFromFacts,
  storefrontTemplateTheme,
  type StoreShape,
  type StorefrontThemeBlocks,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { productCardImageSizes, productGridSpec } from "@/lib/product-card-layout";
import { LIST_ROW_IMAGE_SIZES } from "@/lib/catalog-listing";
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
    listingProps("https://shop.test/search?q=linen", { pathname: "/search", resetPath: "/search?q=linen", searchLabel: "Search products", countEndpoint: "/products" }),
  empty: () =>
    listingProps("https://shop.test/categories/sarees?size=L", { products: [], pagination: { page: 1, totalPages: 0, total: 0 } }),
};

describe("default listing (sidebar-grid)", () => {
  it.each(Object.keys(BASELINES))("renders the %s state exactly as before", async (name) => {
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
  if (variant === "shelves" || variant === "quick-grid") theme.blocks.listing.filters = { style: "drawer", openByDefault: false };
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
const gridSizes = (context: "grid" | "beside-filters") => {
  const layout = requestThemeFor(DEFAULT_STOREFRONT_THEME, STORE_SHAPE).layout;
  return productCardImageSizes(productGridSpec(layout.grid, "square"), "90rem", context);
};

describe("listing layouts", () => {
  it("the drawer filter style puts the facets in a drawer behind a filter bar, over a full-width grid", async () => {
    const document = await renderListing(themeWith({ filters: { style: "drawer", openByDefault: false }, toolbar: ["result-count", "sort", "per-page"] }), plain());
    const drawer = document.querySelector("#filter-section")!;
    expect(drawer.getAttribute("data-catalog-dialog")).toBe("drawer");
    expect(drawer.className).not.toContain("lg:static");
    const bar = document.querySelector("[data-catalog-filter-bar]")!;
    expect(bar.querySelector("button[data-catalog-filter-toggle][aria-controls='filter-section']")).not.toBeNull();
    expect(bar.textContent).toContain("Showing 20 of 50 products");
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
    expect(document.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(gridSizes("grid"));
  });

  it("list shows one product per row beside the sidebar", async () => {
    const document = await renderListing(themeWith({ variant: "list" }), plain());
    expect(document.querySelector("#filter-section")!.className).toContain("lg:static");
    expect(document.querySelector(".product-grid-frame")!.getAttribute("data-catalog-results")).toBe("list");
    expect(document.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(LIST_ROW_IMAGE_SIZES);
  });

  it("quick-grid needs the quick-add card and packs its own denser grid", async () => {
    const quickAdd = { variant: "quick-add", settings: {} } as StorefrontThemeBlocks["card"];
    const document = await renderListing(themeWith({ variant: "quick-grid" }, quickAdd), plain());
    const frame = document.querySelector(".product-grid-frame")!;
    expect(frame.getAttribute("data-catalog-results")).toBe("quick");
    expect(frame.getAttribute("style")).toContain("--theme-card-min-phone:6.5rem");
    expect(document.querySelector("#filter-section")!.getAttribute("data-catalog-dialog")).toBe("drawer");
    // Without the quick-add card it falls back to the plain grid; the filter style stays the theme's.
    const fallback = await renderListing(themeWith({ variant: "quick-grid" }), plain());
    expect(fallback.querySelector(".product-grid-frame")!.hasAttribute("data-catalog-results")).toBe(false);
    expect(fallback.querySelector("#filter-section")!.getAttribute("data-catalog-dialog")).toBe("drawer");
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

  it("uses list rows on phones when the theme asks for them", async () => {
    const document = await renderListing(themeWith({ phoneLayout: "list-row" }), plain());
    expect(document.querySelector(".product-grid")!.getAttribute("data-phone-layout")).toBe("list-row");
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
    const two = await renderListing(DEFAULT_STOREFRONT_THEME, few(2));
    expect(two.querySelector("#filter-section")).toBeNull();
    expect(two.querySelector("#mobile-filter-toggle")).toBeNull();
    expect(two.querySelector("select#sortByMobile")).not.toBeNull();
    expect(two.querySelector(".product-card-media img")!.getAttribute("sizes")).toBe(gridSizes("grid"));
    // Four products with nothing that differs between them: still no filters.
    const same = await renderListing(DEFAULT_STOREFRONT_THEME, { ...few(4, []), priceRange: { min: 900, max: 900 } });
    expect(same.querySelector("#filter-section")).toBeNull();
    // Four products with a facet: filters.
    expect((await renderListing(DEFAULT_STOREFRONT_THEME, few(4))).querySelector("#filter-section")).not.toBeNull();
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
    expect(document.body.textContent).not.toContain("Showing 20 of 50");
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
    // The restore script sits right before the grid it marks.
    expect(html).toMatch(/localStorage\.getItem\("scalius:listing-view"\)[^<]*<\/script>\s*<div class="[^"]*product-grid-frame/);
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
    // Without the piece, facet groups carry no ids (the default markup).
    expect((await renderListing(DEFAULT_STOREFRONT_THEME, plain())).querySelector("#catalog-facet-size")).toBeNull();
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
    expect(Array.from(swatches.querySelectorAll("label")).map((label) => label.querySelector("span:not([aria-hidden]):not([data-catalog-facet-count])")!.textContent))
      .toEqual(["Black", "Navy", "Off-white"]);
    expect(swatches.querySelector("span[style]")!.getAttribute("style")).toBe("background:#111111");
    // Each swatch keeps its count, which the live count updates.
    expect(swatches.querySelectorAll("[data-catalog-facet-count]")).toHaveLength(3);
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
    // Each field has a visible label, and the unit sits beside it.
    for (const input of inputs) expect(range.querySelector(`label[for='${input.id}']`)).not.toBeNull();
    expect(Array.from(range.querySelectorAll("label")).map((label) => label.textContent!.trim())).toEqual(["From", "To"]);
    expect(Array.from(range.querySelectorAll("span[aria-hidden]")).map((span) => span.textContent)).toEqual(["in", "in"]);
    // Not a count-driven value: the live count never disables it.
    expect(range.querySelector("[data-catalog-facet]")).toBeNull();
    // The desktop sidebar applies it with its own button (a submit of the whole form).
    expect(range.querySelector("button[type='submit']")!.textContent).toContain("Apply");
  });

  it("keeps an applied range filled, shown as one removable chip, even when its products no longer differ", async () => {
    const narrowed = { ...DISPLAY_SIZE, range: { min: 13.3, max: 13.3 } };
    const url = "https://shop.test/categories/sarees?display-size.min=13&display-size.max=15.6&size=M";
    const document = await renderListing(
      themeWith({ toolbar: ["sort", "aspect-chips"] }),
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
    const theme = themeWith({ toolbar: ["popular-filter-chips", "sort"] });
    const document = await renderListing(
      theme,
      listingProps("https://shop.test/categories/sarees?brand=samsung", {}, [brand, DISPLAY_SIZE]),
      TREE_STORE_SHAPE,
    );
    const chip = document.querySelector("nav[aria-label='Applied filters'] a")!;
    expect([chip.textContent!.trim(), chip.getAttribute("href")]).toEqual(["Brand: Samsung", "/categories/sarees"]);
    const popular = Array.from(document.querySelectorAll("nav[aria-label='Popular filters'] a"));
    expect(popular.map((link) => [link.textContent!.trim(), link.getAttribute("href")])).toEqual([
      ["Xiaomi", "/categories/sarees?brand=samsung&brand=xiaomi"],
      ["Apple", "/categories/sarees?brand=apple&brand=samsung"],
    ]);
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

  it("renders every template's listing without duplicate ids", async () => {
    for (const id of ["boutique", "heritage-editorial", "fashion-value", "spec-catalogue", "rounded-tech", "marketplace", "mass-retail", "department-mall", "daily-essentials", "showcase-landing"] as const) {
      const document = parse(await render(PAGE, storefrontTemplateTheme(id), { kind: "search", listing: plain() }, EMPTY_SLOT, TREE_STORE_SHAPE));
      expect(duplicateIds(document), id).toEqual([]);
      expect(document.querySelectorAll("[data-theme-component='product-card']").length, id).toBeGreaterThan(0);
    }
  });
});
