// @vitest-environment node
/**
 * App skins and slot components through the real pages (Astro
 * container API through a Vite dev server in middleware mode, API stubbed,
 * the app's storefront module stubbed at the render host): a product-main
 * skin draws the main part around the store's own buy form, a skin without
 * one leaves the page to core, product-slot components draw from the page's
 * projection, and a listing_main skin composes the store's filters, sort
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
    { id: "pdp", target: "product_main", settings: [] },
    { id: "grid", target: "listing_main", settings: [] },
    { id: "bar", target: "header", settings: [] },
  ],
  components: [
    { type: "size_guide", targets: ["product.below"], settings: [] },
    { type: "points", targets: ["header.actions"], settings: [] },
  ],
};

function theme(skin: "pdp" | null = "pdp"): StorefrontThemeDocument {
  const document = storefrontTemplateTheme("boutique");
  return {
    ...document,
    blocks: { ...document.blocks, product: { ...document.blocks.product, apps: [{ id: "guide", app: "acme.theme/size_guide", values: {} }] } },
    apps: { skins: {
      ...(skin ? { "product_main": { app: `acme.theme/${skin}`, values: {} } } : {}),
      "listing_main": { app: "acme.theme/grid", values: {} },
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
    const key = record.kind === "component" ? `component:${String(record.type)}` : String(record.target);
    return draw[key]?.(record) ?? null;
  });
  return jobs;
}

// ─── Product page ─────────────────────────────────────────────────────────

const envelope = (data: unknown) => JSON.stringify({ success: true, data });

/** Photos on the product (the gallery cases); the other cases have none. */
let productPhotos = false;
/** The stored size of every photo (the gallery stage adapts to the first). */
let photoSize = { width: 1200, height: 1200 };
const photo = (id: string, index: number) => ({
  id: `pmed_${id}`, mediaId: `med_${id}`, kind: "image", url: `https://cdn.shop.test/media/${id}.jpg`, posterMediaId: null, posterUrl: null,
  altText: `Linen ${id}`, caption: null, ...photoSize, durationMs: null, isPrimary: index === 0, sortOrder: index, status: "ready",
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

describe("a product_main skin", () => {
  it("draws the main part from the page's projection around the store's own buy form, in the page's one batch", async () => {
    const jobs = app({
      "product_main": () => '<article class="acme-pdp"><h1>Linen, by Acme</h1><scalius-embed kind="buy_form" data-title="false"></scalius-embed><scalius-embed kind="reviews"></scalius-embed></article>',
      "component:size_guide": (job) => `<p class="acme-guide">Sizes for ${(job.data as { product: { title: string } }).product.title}</p>`,
    });
    const { calls, response, page } = await renderProduct(theme());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-store");
    expect(calls.filter((call) => call.startsWith("/api/v1/storefront/batch"))).toHaveLength(1);

    const main = page.querySelector('[data-product-main="skin"] [data-sx-app="acme.theme"]')!;
    expect(main.querySelector(".acme-pdp h1")?.textContent).toBe("Linen, by Acme");
    // The store's own buy form, in the skin, with its title left out: one h1 on the page.
    const form = main.querySelector('[data-sx-embed="buy_form"] form#product-buy-form[action="/buy/linen"]');
    expect(form).not.toBeNull();
    expect(main.querySelector('[data-sx-embed="buy_form"] [data-action="add-to-cart"]')).not.toBeNull();
    expect(page.querySelectorAll("h1")).toHaveLength(1);
    // Core's gallery and buy box do not draw beside it; the reviews it placed replace the module.
    expect(page.querySelectorAll("#product-buy-form")).toHaveLength(1);
    expect(page.querySelector('[data-sx-embed="reviews"]')).not.toBeNull();

    // The projection: band availability, market prices, sanitized description, fields, no quantity.
    const skinJob = jobs.find(({ job }) => job.target === "product_main")!;
    expect(skinJob.options?.jsonLd).toBe(false);
    // Drawn before the page's Layout, it still gets the page's store and language by Layout's rules.
    expect(skinJob.context.store).toMatchObject({ name: "Nakshi Ghor", language: "en" });
    const product = (skinJob.job.data as { product: Record<string, unknown> }).product;
    expect(product).toMatchObject({
      id: "prod_linen", title: "Linen shirt", url: "/products/linen", availability: "in_stock",
      price: { amountMinor: 120000, currency: "BDT" }, compareAt: { amountMinor: 150000, currency: "BDT" }, rating: { average: 4.5, count: 2 },
      fields: { "custom.fabric": "Linen" }, descriptionHtml: "<p>Soft linen.</p>",
    });
    expect(JSON.stringify(product)).not.toContain('"stock"');

    // The component in the product.below slot, drawn from the same projection.
    expect(page.querySelector('[data-app-slot="product.below"] .acme-guide')?.textContent).toBe("Sizes for Linen shirt");
    expect(jobs.find(({ job }) => job.kind === "component")?.options?.jsonLd).toBe(false);

    // Structured data stays core's.
    const jsonLd = Array.from(page.querySelectorAll('script[type="application/ld+json"]')).map((node) => JSON.parse(node.textContent ?? "{}")["@type"]);
    expect(jsonLd).toContain("Product");
  });

  it("places the store's gallery where the skin asks for it, with its LCP preload, still in one batch", async () => {
    app({
      "product_main": () => '<article class="acme-pdp"><div class="acme-media"><scalius-embed kind="gallery"></scalius-embed></div><h1>Linen</h1><scalius-embed kind="buy_form" data-title="false"></scalius-embed></article>',
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
    app({ "product_main": () => '<article class="acme-pdp"><h1>Linen</h1><scalius-embed kind="buy_form" data-title="false"></scalius-embed></article>' });
    const own = await renderProduct(theme());
    productPhotos = false;
    expect(own.page.querySelector("[data-product-gallery]")).toBeNull();
    expect(own.page.querySelector('link[rel="preload"][as="image"]')).toBeNull();
  });

  it("fits the gallery stage to the first photo's stored size, not the theme's card ratio: no bands", async () => {
    app({
      "product_main": () => '<article class="acme-pdp"><scalius-embed kind="gallery"></scalius-embed><h1>Linen</h1><scalius-embed kind="buy_form" data-title="false"></scalius-embed></article>',
    });
    // A portrait card ratio (Noor's) with square photos: a square stage.
    const portraitCards = theme();
    portraitCards.tokens = { ...portraitCards.tokens, imageRatio: "portrait" };
    productPhotos = true;
    const stages = (page: Document) => [...page.querySelectorAll('[data-image-stage="mobile"], [data-image-stage="desktop"]')].map((stage) => stage.getAttribute("style"));
    try {
      const square = await renderProduct(portraitCards);
      expect(stages(square.page)).toEqual([null, null]);
      // Portrait photos get their own 3:4 stage, a panorama the nearest bound.
      photoSize = { width: 1200, height: 1600 };
      expect(stages((await renderProduct(portraitCards)).page)).toEqual(["aspect-ratio: 0.75;", "aspect-ratio: 0.75;"]);
      photoSize = { width: 3000, height: 1000 };
      expect(stages((await renderProduct(portraitCards)).page)).toEqual(["aspect-ratio: 1.7778;", "aspect-ratio: 1.7778;"]);
      // A photo of unknown size keeps the theme's ratio.
      photoSize = { width: null, height: null } as never;
      expect(stages((await renderProduct(portraitCards)).page)).toEqual(["aspect-ratio: 0.75;", "aspect-ratio: 0.75;"]);
    } finally {
      productPhotos = false;
      photoSize = { width: 1200, height: 1200 };
    }
  });

  it("leaves the product page to core when the skin places no buy form, draws nothing, or is not chosen", async () => {
    app({ "product_main": () => '<article class="acme-pdp"><h1>No way to buy</h1></article>' });
    const missing = await renderProduct(theme());
    expect(missing.page.querySelector(".acme-pdp")).toBeNull();
    expect(missing.page.querySelector("#product-buy-form")).not.toBeNull();
    expect(missing.page.querySelectorAll("h1")).toHaveLength(1);

    vi.restoreAllMocks();
    const jobs = app({});
    const none = await renderProduct(theme(null));
    expect(none.page.querySelector("[data-product-main]")).toBeNull();
    expect(none.page.querySelector("#product-buy-form")).not.toBeNull();
    expect(jobs.some(({ job }) => job.target === "product_main")).toBe(false);
  });
});

describe("an app header skin", () => {
  const withHeader = (mobileNav: { variant: string; settings: Record<string, unknown> }): StorefrontThemeDocument => {
    const document = theme();
    return {
      ...document,
      blocks: { ...document.blocks, mobileNav } as StorefrontThemeDocument["blocks"],
      apps: { skins: { ...document.apps?.skins, header: { app: "acme.theme/bar", values: {} } } },
    } as StorefrontThemeDocument;
  };
  const header = '<header class="acme-header"><button type="button" popovertarget="acme-drawer">Menu</button><div id="acme-drawer" popover="auto" data-menu-drawer>Menu</div></header>';

  it("keeps the theme's bottom tabs, whose menu tab opens the header's own drawer", async () => {
    const jobs = app({ header: () => header, "product_main": () => null });
    const { page } = await renderProduct(withHeader({ variant: "bottom-tabs", settings: { tabs: ["home", "categories", "offers", "account"], drawer: "drill-in" } }));
    expect(page.querySelector(".acme-header")).not.toBeNull();
    expect(page.querySelector("#site-header")).toBeNull();
    expect(page.querySelectorAll("#mobile-tab-bar")).toHaveLength(1);
    const tab = page.querySelector<HTMLAnchorElement>("#mobile-tab-bar [data-app-menu-open]")!;
    expect(tab.getAttribute("href")).toBe("/categories");
    expect(page.querySelector("#mobile-tab-bar [data-mobile-menu-open]")).toBeNull();
    const data = jobs.find(({ job }) => job.target === "header")!.job.data as { phoneNavigation?: unknown };
    expect(data.phoneNavigation).toEqual({ menu: "drill", tabBar: true });
  });

  it("draws no tab bar for a drawer phone navigation", async () => {
    const jobs = app({ header: () => header, "product_main": () => null });
    const { page } = await renderProduct(withHeader({ variant: "accordion-drawer", settings: {} }));
    expect(page.querySelector(".acme-header")).not.toBeNull();
    expect(page.querySelector("#mobile-tab-bar")).toBeNull();
    const data = jobs.find(({ job }) => job.target === "header")!.job.data as { phoneNavigation?: unknown };
    expect(data.phoneNavigation).toEqual({ menu: "accordion", tabBar: false });
  });
});

describe("the header.actions slot", () => {
  const points = () => '<a class="acme-points" href="/apps/acme.theme/points">120 points</a>';
  const withHeader = (): StorefrontThemeDocument => {
    const document = theme(null);
    return { ...document, apps: { skins: { ...document.apps?.skins, header: { app: "acme.theme/bar", values: {} } } } } as StorefrontThemeDocument;
  };

  it("draws an app's points in the core header, in the page's one batch, with no new read", async () => {
    const jobs = app({ "component:points": points });
    const { calls, page } = await renderProduct(theme(null));
    expect(page.querySelector('#site-header .hdr-actions [data-app-slot="header.actions"] .acme-points')?.textContent).toBe("120 points");
    expect(jobs.filter(({ job }) => job.kind === "component" && job.target === "header.actions")).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("/api/v1/storefront/batch"))).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("draws them where an app header skin places the slot, and nothing where it does not", async () => {
    app({ header: () => '<header class="acme-header"><nav><scalius-embed kind="slot" data-name="header.actions"></scalius-embed></nav></header>', "component:points": points });
    const { page } = await renderProduct(withHeader());
    expect(page.querySelector('.acme-header nav [data-app-slot="header.actions"] .acme-points')?.textContent).toBe("120 points");
    expect(page.querySelector("#site-header")).toBeNull();
    app({ header: () => '<header class="acme-header"></header>', "component:points": points });
    expect((await renderProduct(withHeader())).page.querySelector(".acme-points")).toBeNull();
  });

  it("draws them in Noor's own header skin (the packed module)", async () => {
    const { BUNDLED_STOREFRONT_EXTENSIONS } = await server.ssrLoadModule("/src/extensions/bundled.gen.ts") as { BUNDLED_STOREFRONT_EXTENSIONS: Record<string, { module(): Promise<{ default: { render(batch: unknown): { results: Array<{ html?: string }> } } }> }> };
    const noor = (await BUNDLED_STOREFRONT_EXTENSIONS["scalius.noor"]!.module()).default;
    const { NOOR_EXTENSION } = await server.ssrLoadModule("/src/gallery/noor.ts") as { NOOR_EXTENSION: { skins: Array<{ id: string; settings: never }> } };
    const { resolveStorefrontSettings } = await server.ssrLoadModule("@scalius/shared/plugins/storefront-components") as { resolveStorefrontSettings: (schema: never, stored: unknown, data: unknown) => Record<string, unknown> };
    const settings = resolveStorefrontSettings(NOOR_EXTENSION.skins.find((skin) => skin.id === "noor_header")!.settings, {}, { image: () => null, products: () => [] });
    app({
      header: (job) => noor.render({ abi: 1, context: { store: { name: "Nakshi Ghor", currency: "BDT", locale: "en-BD", language: "en", timeZone: "Asia/Dhaka" }, page: { kind: "product", path: "/products/linen" }, assets: "/_x/", preview: false }, jobs: [{ ...job, id: "h", component: "noor_header", settings }] }).results.map((result) => result.html ?? (() => { throw new Error(JSON.stringify(result)); })())[0]!,
      "component:points": points,
    });
    const { page } = await renderProduct(withHeader());
    expect(page.querySelector('.noor-header-end [data-app-slot="header.actions"] .acme-points')?.textContent).toBe("120 points");
  });

  it("renders nothing when its component draws nothing", async () => {
    app({});
    const { page } = await renderProduct(theme(null));
    expect(page.querySelector('[data-app-slot="header.actions"]')).toBeNull();
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

describe("a listing_main skin", () => {
  it("draws the listing from its projection with the store's sort, and appends the page links it left out", async () => {
    const { jobs, page } = await renderListing({
      "listing_main": (job) => {
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
    const data = jobs.find(({ job }) => job.target === "listing_main")!.job.data as Record<string, unknown>;
    expect(data).toMatchObject({
      kind: "category", title: "Sarees", total: 50, page: 2, pageCount: 3, descriptionHtml: "<p>Handwoven.</p>",
      fields: { "custom.season": "Eid" }, breadcrumbs: [{ title: "Home", url: "/" }, { title: "Sarees", url: "/categories/sarees" }],
    });
  });

  it("leaves the listing to core when the skin draws nothing", async () => {
    const { page } = await renderListing({ "listing_main": () => "" });
    expect(page.querySelector("[data-listing-main]")).toBeNull();
    expect(page.querySelector("[data-catalog-band]")).not.toBeNull();
  });
});

it("keeps the default theme free of skins", () => {
  expect(DEFAULT_STOREFRONT_THEME.apps).toBeUndefined();
});
