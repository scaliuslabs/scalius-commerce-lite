// @vitest-environment node
// A Bangla store's key pages, rendered in-process the way buyers get them:
// every word the store itself writes comes from the catalogs (English and
// Bangla), and every number, price and count is in Bangla digits. Merchant
// data here is Bangla too, so an English word on the page is a missed string.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, pickProductPageCopy } from "@scalius/shared/checkout-language";
import {
  STOREFRONT_TEMPLATE_IDS,
  storefrontTemplateTheme,
  storeShapeFromFacts,
  type StorefrontTemplateId,
} from "@scalius/shared/storefront-theme";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string> }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
const pages: Record<string, unknown> = {};
let runtimeModule: RuntimeModule;

const PAGE_MODULES = {
  product: "products/[slug]",
  category: "categories/[slug]",
  categories: "categories/index",
  search: "search/index",
  "search-empty": "search/index",
} as const;
type PageKind = keyof typeof PAGE_MODULES;

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
          name: "bangla-pages-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0bangla-pages-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0bangla-pages-test:") ? VIRTUAL_MODULES[id.slice("\0bangla-pages-test:".length)] : undefined,
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
  for (const [kind, path] of Object.entries(PAGE_MODULES)) {
    pages[kind] = (await server.ssrLoadModule(`/src/pages/${path}.astro`)).default;
  }
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const IMAGE = "https://cdn.shop.test/panjabi.jpg";
const PRODUCT = {
  id: "prod_1", name: "সুতির পাঞ্জাবি", slug: "panjabi", description: "<p>হাতে বোনা সুতি।</p>",
  price: 1750, discountedPrice: 1500, discountType: "flat", discountPercentage: 0, discountAmount: 250,
  imageUrl: IMAGE, imageMediaId: null, hasVariants: true, freeDelivery: false,
  availableForSale: true, priceVaries: false, categoryId: "cat_1", pageTemplate: null,
  options: [{ id: "size", name: "মাপ", position: 0, standardMapping: "size", values: [
    { id: "m", value: "মাঝারি", position: 0 }, { id: "l", value: "বড়", position: 1 },
  ] }],
  attributes: [{ name: "কাপড়", slug: "fabric", value: "সুতি", group: null, unit: null, keySpec: true }],
  features: ["বাংলাদেশে তৈরি"],
};
const VARIANTS = ["m", "l"].map((size, index) => ({
  optionCombinationKey: `size=${size}`, id: `sku_${size}`, productId: "prod_1", sku: `PJ-${size.toUpperCase()}`, price: 1750,
  stock: 5, reservedStock: 0, availabilityBand: "in_stock", trackInventory: true, lowStockThreshold: 2,
  fulfillmentKind: "physical", isDefault: false, deletedAt: null, barcode: null, barcodeType: null,
  imageId: null, imageUrl: IMAGE, imageMediaId: null, discountType: null, discountPercentage: null, discountAmount: null,
  selectedOptions: [{ optionDefinitionId: "size", optionValueId: size, name: "মাপ", value: index === 0 ? "মাঝারি" : "বড়", standardMapping: "size", position: 0, valuePosition: index }],
}));
const CATEGORY = { id: "cat_1", name: "পাঞ্জাবি", slug: "panjabi", description: "<p>প্রতিদিনের পাঞ্জাবি।</p>", imageUrl: IMAGE, children: [], ancestors: [] };
// Three pages, a facet with more values than the HTML shows and ratings: the
// listing draws its filters, chips, sort, page links and "See more".
const PAGINATION = { page: 1, limit: 20, total: 52, totalPages: 3 };
const FACETS = [
  {
    id: "option.size", name: "মাপ", slug: "option.size", kind: "option", display: "checkbox", unit: null, range: null,
    values: ["ছোট", "মাঝারি", "বড়", "অনেক বড়", "দ্বিগুণ বড়", "তিনগুণ বড়", "চারগুণ বড়", "পাঁচগুণ বড়", "ছয়গুণ বড়", "সাতগুণ বড়", "আটগুণ বড়", "নয়গুণ বড়", "দশগুণ বড়", "এগারোগুণ বড়"]
      .map((label, index) => ({ value: `s${index}`, label, count: 14 - index, swatch: null })),
  },
  {
    id: "brand", name: "ব্র্যান্ড", slug: "brand", kind: "brand", display: "checkbox", unit: null, range: null,
    values: [{ value: "nakshi", label: "নকশি", count: 30, swatch: null }, { value: "aarong", label: "আড়ং", count: 22, swatch: null }],
  },
];
const LISTING = {
  products: Array.from({ length: 20 }, (_, index) => ({ ...PRODUCT, id: `prod_${index + 1}`, slug: `panjabi-${index + 1}`, hasVariants: false })),
  pagination: PAGINATION, priceRange: { min: 500, max: 2500 }, facets: FACETS,
  ratingFacet: [{ min: 4, count: 20 }, { min: 3, count: 30 }, { min: 2, count: 40 }],
};
const EMPTY_LISTING = { ...LISTING, products: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 }, facets: [], ratingFacet: [] };
const REVIEWS = {
  summary: { average: 4, count: 1, histogram: [{ rating: 4, count: 1 }] },
  items: [{ id: "review_1", rating: 4, title: "ভালো", body: "খুব আরামদায়ক", authorName: "ক্রেতা", verifiedPurchase: true, publishedAt: "2026-09-12T08:00:00.000Z", editedAt: null, reply: null, variantLabel: null }],
  nextCursor: null,
};
const SHIPPING_METHODS = [
  { id: "dhaka", name: "ঢাকা", fee: 60, freeOver: null, sortOrder: 0, isActive: true, kind: "delivery", rateSource: "flat", countries: [{ code: "BD", entire: false }] },
  { id: "outside", name: "ঢাকার বাইরে", fee: 120, freeOver: null, sortOrder: 1, isActive: true, kind: "delivery", rateSource: "flat", countries: [{ code: "BD", entire: false }] },
];
const envelope = (data: unknown) => JSON.stringify({ success: true, data });
const NO_SECTION_DATA = { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null };

async function render(kind: PageKind, template: StorefrontTemplateId) {
  const theme = storefrontTemplateTheme(template);
  const answer = (path: string) => {
    if (path === "/api/v1/storefront/layout") return {
      analytics: [], navigation: [], categoryTree: { nodes: [{ ...CATEGORY, parentId: null, canonicalPath: null }], truncated: false }, footerMenus: [], theme,
      storeShape: storeShapeFromFacts({ productCount: 12, skuCount: 24, topCategoryCount: 1, categoryDepth: 1, menu: [], hasCollections: false, hasDeliveryMethods: true, hasReviews: true, hasKeySpecs: true }),
      brand: { logo: null, footerLogo: null, favicon: null },
      business: { companyName: "নকশি ঘর", socialLinks: [] }, currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 }, policies: [],
      platform: { apiUrl: "https://api.shop.test", storefrontUrl: "https://shop.test", dashboardUrl: "https://admin.shop.test" },
      storefrontCopy: pickProductPageCopy("bn", BANGLA_CHECKOUT_LANGUAGE_DATA),
    };
    if (path === "/api/v1/products/panjabi") return {
      product: { ...PRODUCT, reviews: REVIEWS }, category: CATEGORY,
      media: [{ id: "primary_image", kind: "image", url: IMAGE, alt: "পাঞ্জাবি", isPrimary: true, sortOrder: 0 }],
      variants: VARIANTS, recommendations: { reason: "similar", products: LISTING.products.slice(0, 2) },
    };
    if (path.startsWith("/api/v1/storefront/template/")) return { sections: NO_SECTION_DATA };
    if (path === "/api/v1/shipping-methods") return { shippingMethods: SHIPPING_METHODS };
    if (path === "/api/v1/checkout/config") return { gateways: [{ id: "cod", name: "ক্যাশ অন ডেলিভারি", flow: "cod", countries: ["BD"] }] };
    if (path === "/api/v1/categories/panjabi/products") return { ...LISTING, category: CATEGORY };
    if (path === "/api/v1/navigation/categories") return { nodes: [{ ...CATEGORY, parentId: null, canonicalPath: null, depth: 0 }], truncated: false };
    if (path === "/api/v1/products") return kind === "search-empty" ? EMPTY_LISTING : LISTING;
    // An empty search suggests the store's popular products and its categories.
    if (path === "/api/v1/products/recommendations") return { reason: "popular", products: LISTING.products.slice(0, 4) };
    if (path === "/api/v1/categories") return [CATEGORY];
    throw new Error(`Unexpected render read: ${path}`);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const data = url.pathname === "/api/v1/storefront/batch"
      ? { parts: url.searchParams.getAll("r").map((part) => ({ status: 200, body: envelope(answer(new URL(part, url.origin).pathname)), contentType: "application/json" })) }
      : answer(url.pathname);
    return new Response(envelope(data), { headers: { "Content-Type": "application/json" } });
  }));
  const paths: Record<PageKind, string> = {
    product: "/products/panjabi",
    // A chosen size and a price bound: the applied-filter chips show.
    category: "/categories/panjabi?option.size=s1&minPrice=600",
    categories: "/categories",
    search: "/search?q=পাঞ্জাবি",
    "search-empty": "/search?q=শাড়ি",
  };
  const url = new URL(paths[kind], "https://shop.test");
  const response = await runtimeModule.requestRuntime.run(
    { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", STOREFRONT_URL: "https://shop.test", DASHBOARD_URL: "https://admin.shop.test", inflightReads: new Map() },
    () => container.renderToResponse(pages[kind], { request: new Request(url), locals: {}, params: { slug: "panjabi" } }),
  );
  const html = await response.text();
  expect(response.status, html.slice(0, 300)).toBe(200);
  const document = new Window().document as unknown as Document;
  document.write(html);
  return document;
}

/** What a buyer reads or hears: the title, visible text, and the labels assistive technology reads. */
function buyerText(document: Document): string[] {
  const body = document.body.cloneNode(true) as HTMLElement;
  for (const hidden of body.querySelectorAll("script, style, template, noscript, [hidden]")) hidden.remove();
  const labels = [...body.querySelectorAll("[aria-label], [placeholder], [title], img[alt]")].flatMap((element) =>
    ["aria-label", "placeholder", "title", "alt"].map((name) => element.getAttribute(name) ?? ""));
  // Each text node on its own: elements' text runs together in textContent.
  const texts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) texts.push(node.textContent ?? "");
    for (const child of node.childNodes) walk(child);
  };
  walk(body);
  return [document.title, ...texts, ...labels];
}

/**
 * English words a Bangla page must not show. Merchant data in these fixtures
 * is Bangla, so any Latin-letter word is the store's own interface talking
 * English: the known interface words below are named in failures, and every
 * other Latin word is reported too, so a new missed string fails the same way.
 * `ALLOWED` holds the Latin words a Bangla page may truly carry.
 */
const KNOWN_ENGLISH = new Set([
  "Home", "Breadcrumb", "All", "categories", "Search", "results", "products", "Delivery", "delivery", "Cash", "Free",
  "Pickup", "Returns", "Sort", "Filter", "Filters", "Price", "Add", "cart", "Buy", "now", "Quantity", "Reviews",
  "Description", "Details", "Previous", "Next", "Page", "Show", "more", "less", "Clear", "Apply", "Remove", "Browse",
  "Close", "Zoom", "Latest", "Featured", "Availability", "Top", "Similar",
]);
const ALLOWED = new Set<string>([]);
const LATIN_WORD = /(?<![\p{L}\p{N}])([A-Za-z]{2,})(?![\p{L}\p{N}])/gu;

/** Each English text with its words: `"Sort by:" (known: Sort)`. */
function englishTexts(document: Document): string[] {
  const found = buyerText(document).flatMap((text) => {
    const words = [...text.matchAll(LATIN_WORD)].map((match) => match[1]!).filter((word) => !ALLOWED.has(word));
    if (words.length === 0) return [];
    const known = words.filter((word) => KNOWN_ENGLISH.has(word));
    return [`"${text.trim().replace(/\s+/g, " ").slice(0, 80)}"${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`];
  });
  return [...new Set(found)];
}

/** Latin digits beside a Bangla currency sign or count word ("৳1,750", "12 টি"): numbers not in Bangla digits. */
function latinNumbers(document: Document): string[] {
  return [...new Set(buyerText(document).flatMap((text) => [...text.matchAll(/৳\s?[0-9][0-9,.]*|[0-9]+\s?টি/gu)].map((match) => match[0])))];
}

describe("a Bangla store's pages speak Bangla", () => {
  it("finds English words and Latin-digit prices when a page has them", () => {
    const document = new Window().document as unknown as Document;
    document.write('<html><head><title>পণ্য</title></head><body><p>Sort by:</p><button aria-label="ছবি বড় করুন">৳1,750</button><p>১২টি পণ্য</p></body></html>');
    expect(englishTexts(document)).toEqual(['"Sort by:" (known: Sort)']);
    expect(latinNumbers(document)).toEqual(["৳1,750"]);
  });

  it.each(Object.keys(PAGE_MODULES) as PageKind[])("the %s page has no English interface words and no Latin-digit prices in any template", async (kind) => {
    const findings: Record<string, { english: string[]; latin: string[] }> = {};
    for (const template of STOREFRONT_TEMPLATE_IDS) {
      const document = await render(kind, template);
      expect(document.documentElement.getAttribute("lang")).toBe("bn");
      // The parts that carry the most words are really on the page.
      if (kind === "category") {
        expect(document.querySelector("[data-catalog-facet-more]"), template).not.toBeNull();
        expect(document.querySelector("[data-catalog-filter-apply]"), template).not.toBeNull();
        expect(document.querySelector("[data-catalog-pagination], [data-catalog-paging]"), template).not.toBeNull();
      }
      if (kind === "search-empty") expect(document.querySelector("[data-catalog-empty-state]"), template).not.toBeNull();
      if (kind === "product") expect(document.querySelector("[data-product-summary]"), template).not.toBeNull();
      const english = englishTexts(document);
      const latin = latinNumbers(document);
      if (english.length > 0 || latin.length > 0) findings[template] = { english, latin };
    }
    expect(findings).toEqual({});
  });
});
