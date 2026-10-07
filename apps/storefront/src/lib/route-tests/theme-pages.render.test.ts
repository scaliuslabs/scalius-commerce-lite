// @vitest-environment node
// Real product and listing renders in-process: the theme editor's product and listing
// blocks are the document's blocks.product and blocks.listing, rendered by the
// existing page in its one batch with the protected buyer and SEO rules.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import {
  storefrontSectionDefault,
  storefrontTemplateTheme,
  storeShapeFromFacts,
  type StorefrontSection,
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
/** What the template part answers for a template without sections (the API's `{ sections }` body). */
const NO_SECTION_DATA = { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null };

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
    // The page template's section data (its sections come from the theme; their content needs no data here).
    if (path.startsWith("/api/v1/storefront/template/")) return { sections: NO_SECTION_DATA };
    if (path === "/api/v1/storefront/theme-preview/homepage") return NO_SECTION_DATA;
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
      const body = await request.json() as { token?: string; template?: string };
      expect(body.token).toBe(PREVIEW_TOKEN);
      // The draft's template sections are the one preview read with more in its body.
      if (url.pathname.endsWith("/theme-preview/homepage")) expect(body.template).toBe(kind === "product" ? "product" : "collection");
      else expect(body).toEqual({ token: PREVIEW_TOKEN });
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
  // The batch, then a preview's private reads (resolve, a product's app blocks, and the draft template's sections when it has any; never on search); an empty search also reads suggestions.
  const templateRead = kind !== "search" && options.preview && options.preview.pages.templates[kind === "product" ? "product" : "collection"].sections.length > 0 ? 1 : 0;
  expect(calls).toHaveLength(options.preview ? 2 + (kind === "product" ? 1 : 0) + templateRead : options.empty ? 3 : 1);
  expect(calls[0]!.pathname).toBe("/api/v1/storefront/batch");
  // Every page's parts plus the template part (product, category and collection pages; not search).
  const parts = calls[0]!.searchParams.getAll("r");
  expect(parts).toHaveLength((kind === "product" ? 5 : 2) + (kind === "search" ? 0 : 1));
  if (kind !== "search") expect(parts).toContain(`/api/v1/storefront/template/${kind === "product" ? "product" : "collection"}`);
  else expect(parts.some((part) => part.includes("/storefront/template/"))).toBe(false);
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  return { document, html, response, calls };
}

const resourceSchema = (document: Document) => [...document.querySelectorAll('script[type="application/ld+json"]')].map((element) => JSON.parse(element.textContent ?? "{}"));
const marks = (document: Document) => [...document.querySelectorAll("[data-theme-section-id]")].map((element) => element.getAttribute("data-theme-section-id"));
/** The product page's modules in page order, by the heading or region each one renders. */
const moduleOrder = (html: string, markers: Record<string, string>) =>
  Object.entries(markers).filter(([, marker]) => html.includes(marker)).sort((left, right) => html.indexOf(left[1]) - html.indexOf(right[1])).map(([module]) => module);

/** The theme editor edits these parts of the document as the product and listing pages' blocks. */
function productTheme(below: StorefrontThemeDocument["blocks"]["product"]["below"]) {
  const theme = storefrontTemplateTheme("department-mall");
  theme.blocks.product = { ...theme.blocks.product, below };
  return theme;
}

describe("product page structure from the theme's product blocks", () => {
  const MARKERS = { description: 'id="description"', "spec-table": 'id="specifications"', reviews: 'id="reviews"' };

  it("renders the modules in the merchant's order and leaves out a hidden one, in one batch", async () => {
    const first = await render("product", productTheme(["reviews", "spec-table", "description"]));
    expect(moduleOrder(first.html, MARKERS)).toEqual(["reviews", "spec-table", "description"]);
    const second = await render("product", productTheme(["description", "reviews"]));
    expect(moduleOrder(second.html, MARKERS)).toEqual(["description", "reviews"]);
    expect(second.html).not.toContain('id="specifications"');
    expect(second.document.querySelectorAll("#product-buy-form")).toHaveLength(1);
    // A buyer's page carries no editor marks.
    expect(marks(second.document)).toEqual([]);
  });

  it("keeps exact-SKU image precedence, the primary-image fallback, JSON-LD and noIndex", async () => {
    const theme = productTheme(["reviews", "description"]);
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

  it("previews the draft's app blocks privately and marks every part the editor selects", async () => {
    const live = storefrontTemplateTheme("department-mall");
    for (const previewLabel of ["Draft guide", "Historical guide"]) {
      const { document, html, response, calls } = await render("product", live, { preview: productTheme(["description", "reviews"]), previewLabel });
      expect(html).toContain(previewLabel);
      expect(html).not.toContain("Size guide app");
      expect(calls[2]!.pathname).toBe("/api/v1/storefront/theme-preview/product-apps/shirt");
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      // Every page's announcement bar, header and footer are marked too.
      expect(marks(document)).toEqual(["announcement", "header", "product-main", "module-description", "module-reviews", "product-apps", "footer"]);
    }
    const failed = await render("product", live, { preview: productTheme(["description"]), previewAppsStatus: 503 });
    expect(failed.html).not.toContain("Size guide app");
    expect(failed.response.headers.get("Cache-Control")).toContain("no-store");
  });
});

describe("a product page's template sections", () => {
  const editorial = (id: string, heading: string) => {
    const base = storefrontSectionDefault("editorial", id);
    return { ...base, settings: { ...base.settings, layout: "rich-text", heading, body: `${heading} body.` } } as StorefrontSection;
  };
  /** One section above the product information (`main: 1`) and one below it. */
  const templated = () => {
    const theme = productTheme(["description", "reviews"]);
    theme.pages.templates.product = { sections: [editorial("tpl-above", "Above the product"), editorial("tpl-below", "Below the product")], main: 1 };
    return theme;
  };

  it("draws them around the product information, in order, unmarked for buyers and marked in a preview", async () => {
    const live = await render("product", templated());
    const html = live.html;
    expect(html).toContain("Above the product");
    expect(html).toContain("Below the product");
    expect(html.indexOf("Above the product")).toBeLessThan(html.indexOf('id="product-container"'));
    expect(html.indexOf('id="product-container"')).toBeLessThan(html.indexOf("Below the product"));
    expect(marks(live.document)).toEqual([]);
    expect(html).not.toContain("data-theme-region");

    const preview = await render("product", storefrontTemplateTheme("department-mall"), { preview: templated() });
    expect(preview.html).toContain("Above the product");
    // Each region is marked for the editor's bridge, and the fixed part keeps its own marks between them.
    expect([...preview.html.matchAll(/data-theme-region="([a-z]+)"/g)].map((match) => match[1])).toEqual(["before", "after"]);
    expect(marks(preview.document)).toEqual(["announcement", "header", "tpl-above", "product-main", "module-description", "module-reviews", "product-apps", "tpl-below", "footer"]);
  });

  it("renders the regions empty in a preview of a template without sections, and nothing for buyers", async () => {
    const theme = storefrontTemplateTheme("department-mall");
    expect((await render("product", theme)).html).not.toContain("data-theme-region");
    const preview = await render("product", theme, { preview: theme });
    expect([...preview.html.matchAll(/data-theme-region="([a-z]+)"/g)].map((match) => match[1])).toEqual(["before", "after"]);
  });
});

describe("listing pages from the theme's listing blocks", () => {
  for (const kind of ["category", "collection", "search"]) {
    it(`renders the ${kind} page in one batch, with editor marks only in a preview`, async () => {
      const theme = storefrontTemplateTheme("department-mall");
      const live = await render(kind, theme);
      expect(live.document.querySelector('[data-theme-component="product-card"]')).not.toBeNull();
      expect(marks(live.document)).toEqual([]);
      const preview = await render(kind, theme, { preview: theme });
      expect(marks(preview.document)).toEqual(["announcement", "header", "listing", "listing-filters", "footer"]);
    });
  }

  it("leaves the breadcrumb out visually when its toolbar piece is off", async () => {
    const theme = storefrontTemplateTheme("department-mall");
    theme.blocks.listing = { ...theme.blocks.listing, toolbar: theme.blocks.listing.toolbar.filter((piece) => piece !== "breadcrumb") };
    const { document } = await render("category", theme);
    const crumbs = document.querySelector('nav[aria-label="Breadcrumb"]');
    // Kept for assistive technology (it matches the BreadcrumbList JSON-LD), hidden on screen.
    expect(crumbs?.getAttribute("class") ?? "").toContain("sr-only");
  });

  it("renders an empty search with useful category links", async () => {
    const { document } = await render("search", storefrontTemplateTheme("department-mall"), { empty: true });
    expect(document.querySelector("[data-catalog-empty-state]")?.textContent).toContain("No matching products");
  });
});
