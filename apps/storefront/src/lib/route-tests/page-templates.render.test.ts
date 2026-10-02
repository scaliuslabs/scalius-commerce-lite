// @vitest-environment node
// Real page renders in-process: fixed blocks share the existing batch and buyer/SEO rules.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import {
  storefrontTemplateTheme,
  storeShapeFromFacts,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";
const PREVIEW_TOKEN = `tpv_${"p".repeat(48)}`;

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string> }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
const pages: Record<string, unknown> = {};
let LandingPage: unknown;
let CmsPage: unknown;
let runtimeModule: RuntimeModule;

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
          name: "theme-editor-preview-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0theme-editor-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0theme-editor-test:") ? VIRTUAL_MODULES[id.slice("\0theme-editor-test:".length)] : undefined,
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
  for (const [kind, path] of Object.entries({ product: "products/[slug]", category: "categories/[slug]", collection: "collections/[id]", search: "search/index" })) {
    pages[kind] = (await server.ssrLoadModule(`/src/pages/${path}.astro`)).default;
  }
  LandingPage = (await server.ssrLoadModule("/src/pages/pages/[slug].astro")).default;
  CmsPage = (await server.ssrLoadModule("/src/pages/[slug].astro")).default;
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PRIMARY = "https://cdn.shop.test/primary.jpg";
const BLUE = "https://cdn.shop.test/blue.jpg";
const PRODUCT = {
  id: "prod_1", name: "Cotton shirt", slug: "shirt", description: "<p>Handwoven cotton.</p>",
  price: 1200, discountedPrice: 1200, discountType: null, discountPercentage: 0, discountAmount: 0,
  imageUrl: PRIMARY, imageMediaId: null, hasVariants: true, freeDelivery: false,
  availableForSale: true, priceVaries: false, categoryId: "cat_1", pageTemplate: null,
  options: [{ id: "color", name: "Colour", position: 0, standardMapping: "color", values: [
    { id: "blue", value: "Blue", position: 0 }, { id: "red", value: "Red", position: 1 },
  ] }],
  attributes: [{ name: "Fabric", slug: "fabric", value: "Cotton", group: null, unit: null, keySpec: true }],
  features: ["Made in Bangladesh"],
};
const VARIANTS = ["blue", "red"].map((color) => ({
  optionCombinationKey: `color=${color}`, id: `sku_${color}`, productId: "prod_1", sku: `SHIRT-${color.toUpperCase()}`, price: 1200,
  stock: 5, reservedStock: 0, availabilityBand: "in_stock", trackInventory: true, lowStockThreshold: 2,
  fulfillmentKind: "physical", isDefault: false, deletedAt: null, barcode: null, barcodeType: null,
  imageId: color === "blue" ? "blue_image" : null, imageUrl: color === "blue" ? BLUE : PRIMARY,
  imageMediaId: null, discountType: null, discountPercentage: null, discountAmount: null,
  selectedOptions: [{ optionDefinitionId: "color", optionValueId: color, name: "Colour", value: color === "blue" ? "Blue" : "Red", standardMapping: "color", position: 0, valuePosition: color === "blue" ? 0 : 1 }],
}));
const CATEGORY = { id: "cat_1", name: "Shirts", slug: "shirts", description: "<p>Everyday shirts.</p>", imageUrl: PRIMARY, children: [], ancestors: [] };
const PAGINATION = { page: 1, limit: 20, total: 20, totalPages: 1 };
const LISTING = {
  products: Array.from({ length: 20 }, (_, index) => ({ ...PRODUCT, id: `prod_${index + 1}`, slug: `shirt-${index + 1}`, hasVariants: false })),
  pagination: PAGINATION, priceRange: { min: 500, max: 1500 }, facets: [],
};
const REVIEWS = {
  summary: { average: 5, count: 1, histogram: [{ rating: 5, count: 1 }] },
  items: [{ id: "review_1", rating: 5, title: "Great shirt", body: "Very soft", authorName: "Buyer", verifiedPurchase: true, publishedAt: "2026-09-12T08:00:00.000Z", editedAt: null, reply: null, variantLabel: null }],
  nextCursor: null,
};
const envelope = (data: unknown) => JSON.stringify({ success: true, data });

async function render(kind: string, theme: StorefrontThemeDocument, options: { variant?: string; noIndex?: boolean; empty?: boolean; preview?: StorefrontThemeDocument; previewLabel?: string; previewAppsStatus?: number } = {}) {
  const calls: URL[] = [];
  const answer = (path: string) => {
    if (path === "/api/v1/storefront/layout") return {
      analytics: [], navigation: [], categoryTree: { nodes: [{ ...CATEGORY, parentId: null, canonicalPath: null }], truncated: false }, footerMenus: [], theme, storeShape: storeShapeFromFacts({ productCount: 20, skuCount: 40, topCategoryCount: 1, categoryDepth: 1, menu: [], hasCollections: true, hasDeliveryMethods: true, hasReviews: true, hasKeySpecs: true }), brand: { logo: null, footerLogo: null, favicon: null },
      business: { companyName: "Nakshi Ghor", socialLinks: [] }, currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 }, policies: [],
      platform: { apiUrl: "https://api.shop.test", storefrontUrl: "https://shop.test", dashboardUrl: "https://admin.shop.test" },
    };
    if (path === "/api/v1/storefront/theme-preview/resolve") return {
      theme: options.preview, draftRevision: 7, basePublishedRevision: 2, expiresAt: "2026-10-04T01:00:00.000Z", brand: { logo: null, footerLogo: null, favicon: null },
    };
    if (path === "/api/v1/storefront/theme-preview/product-apps/shirt") return { blocks: [{ id: "preview-guide", app: "scalius.size-guide/guide", placement: "below", html: `<p>${options.previewLabel ?? "Draft guide"}</p>`, head: { meta: [], jsonLd: [] } }] };
    if (path === "/api/v1/products/shirt") return {
      product: { ...PRODUCT, noIndex: options.noIndex === true, reviews: REVIEWS }, category: CATEGORY,
      media: [
        { id: "primary_image", kind: "image", url: PRIMARY, alt: "Primary", isPrimary: true, sortOrder: 0 },
        { id: "blue_image", kind: "image", url: BLUE, alt: "Blue shirt", isPrimary: false, sortOrder: 1 },
      ], variants: VARIANTS, recommendations: { reason: "similar", products: LISTING.products.slice(0, 2) },
    };
    if (path === "/api/v1/storefront/product-apps/shirt") return { blocks: [{ id: "size-guide", app: "scalius.size-guide/guide", placement: "below", html: "<p>Size guide app</p>", head: { meta: [], jsonLd: [] } }] };
    if (path === "/api/v1/shipping-methods") return { shippingMethods: [] };
    if (path === "/api/v1/checkout/config") return { gateways: [] };
    if (path === "/api/v1/categories/shirts/products") return { ...LISTING, category: { ...CATEGORY, noIndex: options.noIndex === true } };
    if (path === "/api/v1/collections/eid") return { ...LISTING, collection: { id: "eid", name: "Eid edit", description: "Eid shirts", noIndex: options.noIndex === true }, categories: [CATEGORY] };
    if (path === "/api/v1/products") return options.empty ? { ...LISTING, products: [], pagination: { ...PAGINATION, total: 0, totalPages: 0 } } : LISTING;
    throw new Error(`Unexpected render read: ${path}`);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    if (url.pathname.startsWith("/api/v1/storefront/theme-preview/")) {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({ token: PREVIEW_TOKEN });
      if (url.pathname.endsWith("/product-apps/shirt") && options.previewAppsStatus) return new Response("{}", { status: options.previewAppsStatus });
    }
    const data = url.pathname === "/api/v1/storefront/batch"
      ? { parts: url.searchParams.getAll("r").map((part) => ({ status: 200, body: envelope(answer(new URL(part, url.origin).pathname)), contentType: "application/json" })) }
      : answer(url.pathname);
    return new Response(envelope(data), { headers: { "Content-Type": "application/json" } });
  }));
  const paths: Record<string, string> = { product: "/products/shirt", category: "/categories/shirts", collection: "/collections/eid", search: "/search" };
  const url = new URL(paths[kind]!, "https://shop.test");
  if (options.variant) url.searchParams.set("variant", options.variant);
  const response = await runtimeModule.requestRuntime.run({ PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", STOREFRONT_URL: "https://shop.test", DASHBOARD_URL: "https://admin.shop.test", inflightReads: new Map() }, () => container.renderToResponse(pages[kind], { request: new Request(url, options.preview ? { headers: { Cookie: `stp_theme_preview=${PREVIEW_TOKEN}` } } : {}), locals: {}, params: { slug: kind === "product" ? "shirt" : "shirts", id: "eid" } }));
  const html = await response.text();
  const document = new Window().document as unknown as Document;
  document.write(html);
  expect(response.status, html.slice(0, 200)).toBe(200);
  expect(calls).toHaveLength(options.preview ? 3 : 1);
  expect(calls[0]!.pathname).toBe("/api/v1/storefront/batch");
  expect(calls[0]!.searchParams.getAll("r")).toHaveLength(kind === "product" ? 5 : 2);
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  return { document, html, response, calls };
}

function customizedTheme() {
  const theme = storefrontTemplateTheme("department-mall");
  theme.pages.product.blocks.reverse();
  theme.pages.collection.blocks = [
    { id: "grid", hidden: false }, { id: "banner", hidden: false }, { id: "breadcrumbs", hidden: false }, { id: "filters", hidden: false },
  ];
  theme.pages.search.blocks = structuredClone(theme.pages.collection.blocks);
  return theme;
}
const order = (document: Document) => [...document.querySelectorAll("[data-theme-template-block]")].map((element) => element.getAttribute("data-theme-template-block"));
const resourceSchema = (document: Document) => [...document.querySelectorAll('script[type="application/ld+json"]')].map((element) => JSON.parse(element.textContent ?? "{}"));

describe("composed theme page templates", () => {
  it("renders every product block in merchant order with one native buy form and one batch", async () => {
    const theme = customizedTheme();
    const { document } = await render("product", theme, { variant: "sku_blue" });
    expect(order(document)).toEqual(theme.pages.product.blocks.map((block) => block.id));
    expect(document.querySelector('[data-theme-template-block="specs"]')?.textContent).toContain("Cotton");
    expect(document.querySelector('[data-theme-template-block="description"]')?.textContent).toContain("Handwoven cotton");
    expect(document.querySelector('[data-theme-template-block="reviews"]')?.textContent).toContain("Great shirt");
    expect(document.querySelector('[data-theme-template-block="apps"]')?.textContent).toContain("Size guide app");
    expect(document.querySelectorAll("#product-buy-form")).toHaveLength(1);
    expect(document.querySelector('[data-action="buy-now"]')?.getAttribute("form")).toBe("product-buy-form");
    expect(document.querySelector("#product-variant-noscript")).not.toBeNull();
    expect(document.querySelectorAll("#product-variants-data")).toHaveLength(1);
  });

  it("renders draft and historical app output from the private preview read, without live app HTML", async () => {
    const live = storefrontTemplateTheme("department-mall");
    for (const previewLabel of ["Draft guide", "Historical guide"]) {
      const { document, html, response, calls } = await render("product", live, { preview: customizedTheme(), previewLabel });
      expect(document.querySelector('[data-theme-template-block="apps"]')?.textContent).toContain(previewLabel);
      expect(html).not.toContain("Size guide app");
      expect(calls[2]!.pathname).toBe("/api/v1/storefront/theme-preview/product-apps/shirt");
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
    const failed = await render("product", live, { preview: customizedTheme(), previewAppsStatus: 503 });
    expect(failed.html).not.toContain("Size guide app");
    expect(failed.document.querySelector('[data-theme-template-block="apps"]')?.textContent?.trim()).toBe("");
  });

  it("hides independent product blocks, keeps no-JS SKU selection and suppresses hidden app/review output", async () => {
    const theme = customizedTheme();
    for (const block of theme.pages.product.blocks) block.hidden = ["options", "reviews", "apps", "specs"].includes(block.id);
    const { document, html } = await render("product", theme);
    expect(order(document)).toEqual(theme.pages.product.blocks.filter((block) => !block.hidden).map((block) => block.id));
    expect(document.querySelector(".variant-option-panels")).toBeNull();
    expect(document.querySelector("#product-variant-noscript")).not.toBeNull();
    expect(html).not.toContain("Size guide app");
    expect(resourceSchema(document).find((schema) => schema["@type"] === "ProductGroup")?.aggregateRating).toBeUndefined();
  });

  it("retains exact-SKU image precedence and primary-image fallback after gallery reordering", async () => {
    const theme = customizedTheme();
    const blue = (await render("product", theme, { variant: "sku_blue" })).document;
    const red = (await render("product", theme, { variant: "sku_red" })).document;
    expect(blue.querySelector('[data-product-gallery] img[fetchpriority="high"]')?.getAttribute("src")).toContain("blue.jpg");
    expect(red.querySelector('[data-product-gallery] img[fetchpriority="high"]')?.getAttribute("src")).toContain("primary.jpg");
    expect(resourceSchema(blue).find((schema) => schema["@type"] === "Product")?.sku).toBe("SHIRT-BLUE");
    expect(resourceSchema((await render("product", theme)).document).some((schema) => schema["@type"] === "ProductGroup")).toBe(true);
    const hidden = (await render("product", theme, { noIndex: true })).document;
    expect(hidden.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain("noindex,follow");
    expect(resourceSchema(hidden).some((schema) => ["Product", "ProductGroup", "BreadcrumbList"].includes(schema["@type"]))).toBe(false);
  });

  it("renders empty search and useful category links without any additional reads", async () => {
    const { document } = await render("search", customizedTheme(), { empty: true });
    expect(document.querySelector("[data-catalog-empty-state]")?.textContent).toContain("No matching products");
    expect(document.querySelector('[data-catalog-empty-state] a[href="/categories/shirts"]')?.textContent).toBe("Shirts");
  });

  for (const kind of ["category", "collection", "search"]) {
    it(`renders reordered ${kind} blocks in one batch, then omits hidden filters and grid`, async () => {
      const theme = customizedTheme();
      const { document } = await render(kind, theme);
      expect(order(document)).toEqual(["grid", "banner", "breadcrumbs", "filters"]);
      expect(document.querySelector('[data-theme-template-block="grid"] [data-theme-component="product-card"]')).not.toBeNull();
      expect(document.querySelector('[data-theme-template-block="filters"] #filterForm')).not.toBeNull();
      const page = kind === "search" ? theme.pages.search : theme.pages.collection;
      page.blocks.find((block) => block.id === "filters")!.hidden = true;
      const filtered = (await render(kind, theme)).document;
      expect(filtered.querySelector("#filterForm")).toBeNull();
      expect(filtered.querySelector("[aria-controls=filter-section]")).toBeNull();
      page.blocks.find((block) => block.id === "grid")!.hidden = true;
      const noGrid = (await render(kind, theme)).document;
      expect(noGrid.querySelector('[data-theme-component="product-card"]')).toBeNull();
      expect(noGrid.querySelector("h1")?.textContent).toBe(kind === "category" ? "Shirts" : kind === "collection" ? "Eid edit" : "All products");
    });
  }
});
