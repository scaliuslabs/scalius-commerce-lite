// @vitest-environment node
/**
 * App skins and component product blocks through the real pages (Astro
 * container API through a Vite dev server in middleware mode, API stubbed,
 * the app's storefront module stubbed at the render host): a product-main
 * skin draws the main part around the store's own buy form, a skin without
 * one leaves the page to core, component blocks draw from the page's
 * projection, and a listing-main skin composes the store's filters, sort
 * and (always) page links. No skin adds an API read: the page is still one
 * batch.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import { DEFAULT_STOREFRONT_THEME, storefrontTemplateTheme, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import type { StorefrontRenderJob } from "@scalius/shared/plugins/storefront-protocol";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string | undefined> }): Promise<Response>;
  renderToString(component: unknown, options: { props?: object; locals?: object; request?: Request; slots?: Record<string, string> }): Promise<string>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}
type Render = (extension: unknown, job: Omit<StorefrontRenderJob, "id">, options?: { jsonLd?: boolean }) => Promise<string | null>;

let server: ViteDevServer;
let container: Container;
let ProductPage: unknown;
let ListingPage: unknown;
let runtimeModule: RuntimeModule;
let hostPrototype: { render: Render };
let requestThemeFor: (theme: StorefrontThemeDocument) => unknown;
let resolveProductListQueryState: (input: { url: URL; facets: unknown[] }) => { page: number };

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [{
        name: "skins-route-test-virtual-modules",
        resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0skins-test:${id}` : undefined),
        load: (id: string) => (id.startsWith("\0skins-test:") ? VIRTUAL_MODULES[id.slice("\0skins-test:".length)] : undefined),
      }],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({ name: "@astrojs/react", renderer: reactRenderer });
  ProductPage = (await server.ssrLoadModule("/src/pages/products/[slug].astro")).default;
  ListingPage = (await server.ssrLoadModule("/src/components/catalog/CatalogListingPage.astro")).default;
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
  hostPrototype = (await server.ssrLoadModule("/src/lib/extensions/host.ts")).ExtensionHost.prototype;
  requestThemeFor = (await server.ssrLoadModule("/src/lib/storefront-theme-context.ts")).requestThemeFor;
  resolveProductListQueryState = (await server.ssrLoadModule("/src/lib/product-list-query.ts")).resolveProductListQueryState;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

let window = new Window();
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const previous = window;
  window = new Window();
  await previous.happyDOM.close();
});
const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;

// ─── The app and its theme ────────────────────────────────────────────────

const EXTENSION = {
  pluginId: "acme.theme", version: "1.0.0", source: "bundled", release: "c".repeat(64),
  sections: [], sectionSettings: {}, islands: [], stylesheet: false, connect: [],
  skins: [
    { id: "pdp", target: "product-main", settings: [] },
    { id: "grid", target: "listing-main", settings: [] },
  ],
  blocks: [{ type: "size-guide", target: "product.below", settings: [] }],
};

function theme(skin: "pdp" | null = "pdp"): StorefrontThemeDocument {
  const document = storefrontTemplateTheme("boutique");
  return {
    ...document,
    blocks: { ...document.blocks, product: { ...document.blocks.product, apps: [{ id: "guide", app: "acme.theme/size-guide", values: {} }] } },
    apps: { skins: {
      ...(skin ? { "product-main": { app: `acme.theme/${skin}`, values: {} } } : {}),
      "listing-main": { app: "acme.theme/grid", values: {} },
    } },
  } as StorefrontThemeDocument;
}

/** The app's storefront module, as the host would run it: what each job draws, and every job it saw. */
function app(draw: Partial<Record<string, (job: Record<string, unknown>) => string | null>>) {
  type Context = { store: { name: string; language: string } };
  const jobs: Array<{ job: Record<string, unknown>; options: { jsonLd?: boolean } | undefined; context: Context }> = [];
  vi.spyOn(hostPrototype, "render").mockImplementation(async function (this: { context: Context }, _extension, job, options) {
    const record = job as unknown as Record<string, unknown>;
    jobs.push({ job: record, options, context: this.context });
    const key = record.kind === "block" ? `block:${String(record.type)}` : String(record.target);
    return draw[key]?.(record) ?? null;
  });
  return jobs;
}

// ─── Product page ─────────────────────────────────────────────────────────

const envelope = (data: unknown) => JSON.stringify({ success: true, data });

/** Photos on the product (the gallery cases); the other cases have none. */
let productPhotos = false;
const photo = (id: string, index: number) => ({
  id: `pmed_${id}`, mediaId: `med_${id}`, kind: "image", url: `https://cdn.shop.test/media/${id}.jpg`, posterMediaId: null, posterUrl: null,
  altText: `Linen ${id}`, caption: null, width: 1200, height: 1200, durationMs: null, isPrimary: index === 0, sortOrder: index, status: "ready",
});

function productData() {
  return {
    product: {
      id: "prod_linen", name: "Linen shirt", slug: "linen", description: "<p>Soft linen.</p><script>x()</script>",
      price: 1500, discountedPrice: 1200, discountType: "flat", discountPercentage: null, discountAmount: 300,
      freeDelivery: false, isActive: true, metaTitle: null, metaDescription: null, categoryId: null,
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", deletedAt: null,
      imageUrl: productPhotos ? "https://cdn.shop.test/media/front.jpg" : null, imageAlt: null, imageMediaId: productPhotos ? "med_front" : null, hasVariants: false, availableForSale: true, options: [], attributes: [], features: [],
      noIndex: false, canonicalPath: null,
      customFields: [{ namespace: "custom", key: "fabric", name: "Fabric", type: "single_line_text", value: "Linen" }],
      reviews: { summary: { average: 4.5, count: 2, histogram: [] }, items: [], nextCursor: null },
    },
    category: null,
    media: productPhotos ? ["front", "side", "back"].map(photo) : [],
    variants: [{
      id: "sku_linen", productId: "prod_linen", optionCombinationKey: "", imageId: null, imageUrl: null, imageMediaId: null,
      selectedOptions: [], weight: null, sku: "LIN-1", price: 1500, stock: 5, reservedStock: 0, availabilityBand: "in_stock",
      isDefault: true, trackInventory: true, lowStockThreshold: 2, barcode: null, barcodeType: null,
      discountType: null, discountPercentage: null, discountAmount: null, fulfillmentKind: "physical",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", deletedAt: null,
    }],
    recommendations: { reason: "popular", products: [] },
  };
}

function stubApi(document: StorefrontThemeDocument) {
  const calls: string[] = [];
  const layout = {
    analytics: [], navigation: [], footerMenus: [], theme: document,
    brand: { logo: null, footerLogo: null, favicon: null },
    business: { companyName: "Nakshi Ghor", socialLinks: [] },
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
    policies: [], appScripts: [], appExtensions: [EXTENSION],
  };
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout) };
    if (path === "/api/v1/products/linen") return { status: 200, body: envelope(productData()) };
    if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [] }) };
    if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [] }) };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/storefront/batch") {
      const parts = url.searchParams.getAll("r").map((part) => ({ ...answer(new URL(part, url.origin).pathname), contentType: "application/json" }));
      return new Response(envelope({ parts }), { headers: { "Content-Type": "application/json" } });
    }
    const { status, body } = answer(url.pathname);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

async function renderProduct(document: StorefrontThemeDocument) {
  const calls = stubApi(document);
  const response = await runtimeModule.requestRuntime.run(
    { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", STOREFRONT_URL: "https://shop.test", inflightReads: new Map() },
    () => container.renderToResponse(ProductPage, { request: new Request("https://shop.test/products/linen"), locals: {}, params: { slug: "linen" } }),
  );
  return { calls, response, page: parse(await response.text()) };
}

describe("a product-main skin", () => {
  it("draws the main part from the page's projection around the store's own buy form, in the page's one batch", async () => {
    const jobs = app({
      "product-main": () => '<article class="acme-pdp"><h1>Linen, by Acme</h1><scalius-embed kind="buy-form" data-title="false"></scalius-embed><scalius-embed kind="reviews"></scalius-embed></article>',
      "block:size-guide": (job) => `<p class="acme-guide">Sizes for ${(job.data as { product: { title: string } }).product.title}</p>`,
    });
    const { calls, response, page } = await renderProduct(theme());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-store");
    expect(calls.filter((call) => call.startsWith("/api/v1/storefront/batch"))).toHaveLength(1);

    const main = page.querySelector('[data-product-main="skin"] [data-sx-app="acme.theme"]')!;
    expect(main.querySelector(".acme-pdp h1")?.textContent).toBe("Linen, by Acme");
    // The store's own buy form, in the skin, with its title left out: one h1 on the page.
    const form = main.querySelector('[data-sx-embed="buy-form"] form#product-buy-form[action="/buy/linen"]');
    expect(form).not.toBeNull();
    expect(main.querySelector('[data-sx-embed="buy-form"] [data-action="add-to-cart"]')).not.toBeNull();
    expect(page.querySelectorAll("h1")).toHaveLength(1);
    // Core's gallery and buy box do not draw beside it; the reviews it placed replace the module.
    expect(page.querySelectorAll("#product-buy-form")).toHaveLength(1);
    expect(page.querySelector('[data-sx-embed="reviews"]')).not.toBeNull();

    // The projection: band availability, market prices, sanitized description, fields, no quantity.
    const skinJob = jobs.find(({ job }) => job.target === "product-main")!;
    expect(skinJob.options?.jsonLd).toBe(false);
    // Drawn before the page's Layout, it still gets the page's store and language by Layout's rules.
    expect(skinJob.context.store).toMatchObject({ name: "Nakshi Ghor", language: "en" });
    const product = (skinJob.job.data as { product: Record<string, unknown> }).product;
    expect(product).toMatchObject({
      id: "prod_linen", title: "Linen shirt", url: "/products/linen", availability: "in_stock",
      price: { amount: 1200 }, compareAt: { amount: 1500 }, rating: { average: 4.5, count: 2 },
      fields: { "custom.fabric": "Linen" }, descriptionHtml: "<p>Soft linen.</p>",
    });
    expect(JSON.stringify(product)).not.toContain('"stock"');

    // The component block below the modules, drawn from the same projection.
    expect(page.querySelector('[data-app-blocks="below"] .acme-guide')?.textContent).toBe("Sizes for Linen shirt");
    expect(jobs.find(({ job }) => job.kind === "block")?.options?.jsonLd).toBe(false);

    // Structured data stays core's.
    const jsonLd = Array.from(page.querySelectorAll('script[type="application/ld+json"]')).map((node) => JSON.parse(node.textContent ?? "{}")["@type"]);
    expect(jsonLd).toContain("Product");
  });

  it("places the store's gallery where the skin asks for it, with its LCP preload, still in one batch", async () => {
    app({
      "product-main": () => '<article class="acme-pdp"><div class="acme-media"><scalius-embed kind="gallery"></scalius-embed></div><h1>Linen</h1><scalius-embed kind="buy-form" data-title="false"></scalius-embed></article>',
    });
    productPhotos = true;
    const { calls, page } = await renderProduct(theme());
    expect(calls.filter((call) => call.startsWith("/api/v1/storefront/batch"))).toHaveLength(1);
    const gallery = page.querySelectorAll('[data-product-main="skin"] .acme-media [data-sx-embed="gallery"] #product-gallery[data-product-gallery]');
    expect(gallery).toHaveLength(1);
    expect(page.querySelectorAll("[data-product-gallery]")).toHaveLength(1);
    // The first photo is the page's eager, high-priority LCP image, and preloaded.
    expect(page.querySelector('#product-gallery img[fetchpriority="high"]')).not.toBeNull();
    expect(page.querySelector('link[rel="preload"][as="image"]')).not.toBeNull();

    // A skin without one draws its own photos: no core gallery, no preload for it.
    vi.restoreAllMocks();
    app({ "product-main": () => '<article class="acme-pdp"><h1>Linen</h1><scalius-embed kind="buy-form" data-title="false"></scalius-embed></article>' });
    const own = await renderProduct(theme());
    productPhotos = false;
    expect(own.page.querySelector("[data-product-gallery]")).toBeNull();
    expect(own.page.querySelector('link[rel="preload"][as="image"]')).toBeNull();
  });

  it("leaves the product page to core when the skin places no buy form, draws nothing, or is not chosen", async () => {
    app({ "product-main": () => '<article class="acme-pdp"><h1>No way to buy</h1></article>' });
    const missing = await renderProduct(theme());
    expect(missing.page.querySelector(".acme-pdp")).toBeNull();
    expect(missing.page.querySelector("#product-buy-form")).not.toBeNull();
    expect(missing.page.querySelectorAll("h1")).toHaveLength(1);

    vi.restoreAllMocks();
    const jobs = app({});
    const none = await renderProduct(theme(null));
    expect(none.page.querySelector("[data-product-main]")).toBeNull();
    expect(none.page.querySelector("#product-buy-form")).not.toBeNull();
    expect(jobs.some(({ job }) => job.target === "product-main")).toBe(false);
  });
});

// ─── Listing ──────────────────────────────────────────────────────────────

function listingProps(url: string) {
  const queryState = resolveProductListQueryState({ url: new URL(url), facets: [] });
  const product = (id: string) => ({
    id, name: `Product ${id}`, slug: `product-${id}`, description: null, price: 1200, discountedPrice: 1200,
    discountType: null, discountPercentage: null, discountAmount: null, freeDelivery: false, isActive: true,
    metaTitle: null, metaDescription: null, categoryId: null, createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z", deletedAt: null, imageUrl: `https://cdn.shop.test/products/${id}.jpg`,
    imageAlt: null, hasVariants: false, availableForSale: true,
  });
  return {
    products: [product("p1"), product("p2")],
    pagination: { page: queryState.page, totalPages: 3, total: 50 },
    facets: [],
    priceRange: { min: 500, max: 4500 },
    queryState,
    pathname: new URL(url).pathname,
    resetPath: new URL(url).pathname,
    searchLabel: "Search this category",
    countEndpoint: "/categories/sarees/products",
    currencySymbol: "৳",
    currencyCode: "BDT",
  };
}

async function renderListing(draw: Partial<Record<string, (job: Record<string, unknown>) => string | null>>) {
  const jobs = app(draw);
  const layout = { currency: { code: "BDT", symbol: "৳" }, appExtensions: [EXTENSION] };
  const html = await runtimeModule.requestRuntime.run({ layout: Promise.resolve(layout) }, () => container.renderToString(ListingPage, {
    props: {
      kind: "category",
      listing: listingProps("https://shop.test/categories/sarees?page=2"),
      hero: { title: "Sarees", breadcrumb: [{ label: "Sarees", href: "/categories/sarees" }], description: "<p>Handwoven.</p>", count: 50 },
      fields: { "custom.season": "Eid" },
    },
    locals: { storefrontTheme: Promise.resolve(requestThemeFor(theme())) },
    request: new Request("https://shop.test/categories/sarees?page=2"),
  }));
  return { jobs, page: parse(html) };
}

describe("a listing-main skin", () => {
  it("draws the listing from its projection with the store's sort, and appends the page links it left out", async () => {
    const { jobs, page } = await renderListing({
      "listing-main": (job) => {
        const data = job.data as { title: string; cards: Array<{ title: string }> };
        return `<section class="acme-grid"><h1>${data.title}</h1><scalius-embed kind="toolbar"></scalius-embed><ul>${data.cards.map((card) => `<li>${card.title}</li>`).join("")}</ul></section>`;
      },
    });
    const listing = page.querySelector('[data-listing-main="skin"]')!;
    expect(listing.querySelector(".acme-grid h1")?.textContent).toBe("Sarees");
    expect(Array.from(listing.querySelectorAll(".acme-grid li")).map((item) => item.textContent)).toEqual(["Product p1", "Product p2"]);
    expect(listing.querySelector('[data-sx-embed="toolbar"] select[name="sortBy"]')).not.toBeNull();
    // Page links on every listing, so crawlers reach every product.
    const paging = listing.querySelector('[data-sx-embed="pagination"]')!;
    expect(paging.querySelector('a[href*="page=3"]')).not.toBeNull();
    expect(page.querySelector("[data-catalog-band]")).toBeNull();
    const data = jobs.find(({ job }) => job.target === "listing-main")!.job.data as Record<string, unknown>;
    expect(data).toMatchObject({
      kind: "category", title: "Sarees", total: 50, page: 2, pageCount: 3, descriptionHtml: "<p>Handwoven.</p>",
      fields: { "custom.season": "Eid" }, breadcrumbs: [{ title: "Home", url: "/" }, { title: "Sarees", url: "/categories/sarees" }],
    });
  });

  it("leaves the listing to core when the skin draws nothing", async () => {
    const { page } = await renderListing({ "listing-main": () => "" });
    expect(page.querySelector("[data-listing-main]")).toBeNull();
    expect(page.querySelector("[data-catalog-band]")).not.toBeNull();
  });
});

it("keeps the default theme free of skins", () => {
  expect(DEFAULT_STOREFRONT_THEME.apps).toBeUndefined();
});
