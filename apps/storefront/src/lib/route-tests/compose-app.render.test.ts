// @vitest-environment node
/**
 * Composition end to end (packages/plugin-sdk/docs/storefront.md): two real test apps
 * (`apps/api/src/plugins/testing/apps/compose` and `studio`) run as bundled
 * storefront modules through the real render host, in the real pages (Astro
 * container through a Vite dev server, API stubbed). Compose adds badges and
 * a line to every card, including the cards Studio's skin draws, without
 * reading Studio's fields; draws a header from the header facts (menu
 * photos, search within a category, the market, order routes, signed-in
 * parts) with a merchant-picked image; a listing with the category's
 * children; the SKU code and EMI in the buy box; and a heavy wall deferred
 * past the first paint. Its always-failing component and a slow app draw
 * nothing, the page still renders, and it is never stored as proven. The
 * page stays one API batch.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import { storefrontTemplateTheme, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const APPS = fileURLToPath(new URL("../../../../api/src/plugins/testing/apps", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";
const COMPOSE_RELEASE = "a".repeat(64);
const STUDIO_RELEASE = "b".repeat(64);

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string | undefined> }): Promise<Response>;
  renderToString(component: unknown, options: { props?: object; locals?: object; request?: Request }): Promise<string>;
}
interface RuntimeModule { requestRuntime: { run<T>(runtime: object, task: () => T): T } }
type Manifest = { storefront: { components?: Array<{ type: string; targets: string[]; settings?: unknown[] }>; skins?: Array<{ id: string; target: string; settings?: unknown[] }>; islands?: Array<{ name: string }> } };
type Bundled = Record<string, { release: string; module(): Promise<unknown>; files(): Promise<{ FILES: Record<string, never> }> }>;

let server: ViteDevServer;
let container: Container;
let ProductPage: unknown;
let ListingPage: unknown;
let runtimeModule: RuntimeModule;
let bundled: Bundled;
let clearMemo: () => void;
let requestThemeFor: (theme: StorefrontThemeDocument, shape?: unknown, options?: object) => unknown;
let resolveProductListQueryState: (input: { url: URL; facets: unknown[] }) => { page: number };
let createPageDependencies: () => { unproven: boolean };
let composeExtension: Record<string, unknown>;
let studioExtension: Record<string, unknown>;

function extensionOf(pluginId: string, release: string, manifest: Manifest): Record<string, unknown> {
  const storefront = manifest.storefront;
  return {
    pluginId, version: "1.0.0", source: "bundled", release, sections: [], sectionSettings: {}, stylesheet: false, connect: [],
    islands: (storefront.islands ?? []).map((island) => island.name),
    skins: (storefront.skins ?? []).map((skin) => ({ id: skin.id, target: skin.target, settings: skin.settings ?? [] })),
    components: (storefront.components ?? []).map((component) => ({ type: component.type, targets: component.targets, settings: component.settings ?? [] })),
  };
}

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null, fs: { strict: false } },
      appType: "custom",
      plugins: [{
        name: "compose-route-test-virtual-modules",
        resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0compose-test:${id}` : undefined),
        load: (id: string) => (id.startsWith("\0compose-test:") ? VIRTUAL_MODULES[id.slice("\0compose-test:".length)] : undefined),
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
  clearMemo = (await server.ssrLoadModule("/src/lib/extensions/host.ts")).clearExtensionMemo;
  requestThemeFor = (await server.ssrLoadModule("/src/lib/storefront-theme-context.ts")).requestThemeFor;
  resolveProductListQueryState = (await server.ssrLoadModule("/src/lib/product-list-query.ts")).resolveProductListQueryState;
  createPageDependencies = (await server.ssrLoadModule("/src/lib/page-dependencies.ts")).createPageDependencies;
  bundled = (await server.ssrLoadModule("/src/extensions/bundled.gen.ts")).BUNDLED_STOREFRONT_EXTENSIONS as Bundled;
  const compose = (await server.ssrLoadModule(`${APPS}/compose/src/index.ts`)).manifest as Manifest;
  const studio = (await server.ssrLoadModule(`${APPS}/studio/src/index.ts`)).manifest as Manifest;
  composeExtension = extensionOf("acme.compose", COMPOSE_RELEASE, compose);
  studioExtension = extensionOf("acme.studio", STUDIO_RELEASE, studio);
}, 120_000);

afterAll(async () => {
  delete bundled?.["acme.compose"];
  delete bundled?.["acme.studio"];
  await server?.close();
});

let window = new Window();
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearMemo();
  const previous = window;
  window = new Window();
  await previous.happyDOM.close();
});
const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;

/** Both apps compiled into the storefront (as `pnpm plugin add` does), the real modules; `slow` delays Studio's module load. */
function bundle(options: { slowStudioMs?: number } = {}) {
  const load = (dir: string) => () => server.ssrLoadModule(`${APPS}/${dir}/src/storefront.tsx`);
  const files = async () => ({ FILES: {} });
  bundled["acme.compose"] = { release: COMPOSE_RELEASE, module: load("compose"), files };
  bundled["acme.studio"] = {
    release: STUDIO_RELEASE,
    module: options.slowStudioMs
      ? () => new Promise((resolve) => setTimeout(resolve, options.slowStudioMs)).then(load("studio"))
      : load("studio"),
    files,
  };
}

function theme(options: { card?: boolean; listing?: boolean } = {}): StorefrontThemeDocument {
  const document = storefrontTemplateTheme("boutique");
  return {
    ...document,
    blocks: {
      ...document.blocks,
      product: {
        ...document.blocks.product,
        apps: [
          { id: "code", app: "acme.compose/product_code", values: {} },
          { id: "wall", app: "acme.compose/spec_wall", values: {} },
        ],
      },
    },
    apps: {
      skins: {
        header: { app: "acme.compose/compose_header", values: { promo: "med_promo", promo_link: "/categories/phones" } },
        ...(options.card ? { "product_card": { app: "acme.studio/studio_card", values: {} } } : {}),
        ...(options.listing ? { "listing_main": { app: "acme.compose/compose_listing", values: {} } } : {}),
      },
    },
  } as StorefrontThemeDocument;
}

const PROOF = { apiVersion: "api-test", s0: 1, deps: [], validUntil: null, renderedAt: Date.now(), softMaxAgeSeconds: null };
const envelope = (data: unknown) => JSON.stringify({ success: true, data });
const card = (id: string) => ({
  id, name: `Phone ${id}`, slug: `phone-${id}`, description: null, price: 25000, discountedPrice: 25000,
  discountType: null, discountPercentage: null, discountAmount: null, freeDelivery: false, isActive: true,
  metaTitle: null, metaDescription: null, categoryId: null, createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z", deletedAt: null, imageUrl: `https://cdn.shop.test/products/${id}.jpg`,
  imageAlt: null, hasVariants: false, availableForSale: true,
});

function productData() {
  return {
    product: {
      ...card("x1"), name: "Phone X1", slug: "x1", description: "<p>Fast.</p>",
      imageUrl: "https://cdn.shop.test/media/x1.jpg", imageMediaId: "med_x1", options: [], attributes: [], features: [],
      noIndex: false, canonicalPath: null, customFields: [],
      emi: { provider: "City Bank", months: 6, monthly: 4200, monthlyMinor: 420000 },
      reviews: { summary: { average: 0, count: 0, histogram: [] }, items: [], nextCursor: null },
    },
    category: null,
    media: [{
      id: "pmed_x1", mediaId: "med_x1", kind: "image", url: "https://cdn.shop.test/media/x1.jpg", posterMediaId: null, posterUrl: null,
      altText: "Phone X1", caption: null, width: 1200, height: 1200, durationMs: null, isPrimary: true, sortOrder: 0, status: "ready",
    }],
    variants: [{
      id: "sku_x1", productId: "x1", optionCombinationKey: "", imageId: null, imageUrl: null, imageMediaId: null,
      selectedOptions: [], weight: null, sku: "VX-X1-128", price: 25000, stock: 5, reservedStock: 0, availabilityBand: "in_stock",
      isDefault: true, trackInventory: true, lowStockThreshold: 2, barcode: null, barcodeType: null,
      discountType: null, discountPercentage: null, discountAmount: null, fulfillmentKind: "physical",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", deletedAt: null,
    }],
    recommendations: { reason: "popular", products: [card("x2"), card("x3")] },
  };
}

function layout(document: StorefrontThemeDocument, extensions: unknown[]) {
  return {
    analytics: [], footerMenus: [], theme: document,
    navigation: [{ id: "nav_phones", title: "Phones", href: "/categories/phones", imageUrl: "https://cdn.shop.test/media/phones.jpg" }],
    categoryTree: { nodes: [
      { id: "cat_phones", name: "Phones", slug: "phones", parentId: null, canonicalPath: null, imageUrl: "https://cdn.shop.test/media/phones.jpg" },
      { id: "cat_cases", name: "Cases", slug: "cases", parentId: "cat_phones", canonicalPath: null, imageUrl: null },
    ], truncated: false },
    brand: { logo: null, footerLogo: null, favicon: null },
    skinMedia: [{ id: "med_promo", url: "https://cdn.shop.test/media/promo.jpg", alt: "Eid offers", width: 640, height: 320 }],
    business: { companyName: "Volt Gadgets", socialLinks: [] },
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
    policies: [], appScripts: [], appExtensions: extensions,
  };
}

function stubApi(document: StorefrontThemeDocument, extensions: unknown[]) {
  const calls: string[] = [];
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout(document, extensions)) };
    if (path === "/api/v1/products/x1") return { status: 200, body: envelope(productData()) };
    if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [] }) };
    if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [] }) };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/storefront/batch") {
      const parts = url.searchParams.getAll("r").map((part) => ({ ...answer(new URL(part, url.origin).pathname), contentType: "application/json", cache: PROOF }));
      return new Response(envelope({ parts }), { headers: { "Content-Type": "application/json" } });
    }
    const { status, body } = answer(url.pathname);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

async function renderProduct(document: StorefrontThemeDocument, extensions = [composeExtension, studioExtension]) {
  const calls = stubApi(document, extensions);
  const pageDependencies = createPageDependencies();
  const started = performance.now();
  const response = await runtimeModule.requestRuntime.run(
    { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", STOREFRONT_URL: "https://shop.test", inflightReads: new Map(), pageDependencies },
    () => container.renderToResponse(ProductPage, { request: new Request("https://shop.test/products/x1"), locals: {}, params: { slug: "x1" } }),
  );
  const text = await response.text();
  return { calls, response, pageDependencies, ms: performance.now() - started, page: parse(text) };
}

const withoutBroken = () => ({ ...composeExtension, components: (composeExtension.components as Array<{ type: string }>).filter((component) => component.type !== "broken") });

describe("a second app composes into the store's and other apps' units", () => {
  it("draws the header from the header facts with the merchant's image, in the page's one batch", async () => {
    bundle();
    const { calls, page } = await renderProduct(theme());
    expect(calls.filter((call) => call.startsWith("/api/v1/storefront/batch"))).toHaveLength(1);
    const header = page.querySelector('[data-sx-app="acme.compose"] .compose-header')!;
    expect(header).not.toBeNull();
    expect(page.querySelector("#site-header")).toBeNull();
    // Menu items carry their category's photo.
    expect(header.querySelector(".compose-menu-item img.compose-menu-photo")?.getAttribute("src")).toContain("phones");
    // Search within a category: a department select the store's /search understands.
    const select = header.querySelector<HTMLSelectElement>('form[role="search"][action="/search"] select[name="category"]')!;
    expect(Array.from(select.querySelectorAll("option")).map((option) => option.getAttribute("value"))).toEqual(["", "phones"]);
    // Order routes and signed-in parts the browser picks between.
    expect(header.querySelector('a.compose-orders[data-scalius-when="signed-in"]')?.getAttribute("href")).toBe("/account");
    expect(header.querySelector('a.compose-sign-in[data-scalius-when="signed-out"][data-account-link]')).not.toBeNull();
    expect(header.querySelector("a.compose-track")?.getAttribute("href")).toBe("/track-order");
    // The skin's image setting, resolved from the layout read.
    const promo = header.querySelector<HTMLImageElement>(".compose-promo img")!;
    expect(promo.getAttribute("src")).toContain("promo");
    expect(promo.getAttribute("alt")).toBe("Eid offers");
    expect(header.querySelector(".compose-promo")?.getAttribute("href")).toBe("/categories/phones");
    // A single-market store has no country form.
    expect(header.querySelector(".compose-market")).toBeNull();
  });

  it("puts the SKU code and EMI in the buy box and defers the heavy wall past the first paint", async () => {
    bundle();
    const { page } = await renderProduct(theme());
    const code = page.querySelector('[data-app-slot="product.buy_box.after"] .compose-code')!;
    expect(code.textContent).toContain("VX-X1-128");
    expect(code.querySelector("[data-emi-months]")?.getAttribute("data-emi-months")).toBe("6");
    expect(code.textContent).toContain("4,200");
    const wall = page.querySelector('[data-app-slot="product.below"] .compose-wall')!;
    const deferred = wall.querySelector('scalius-deferred[data-hydrate="visible"]')!;
    expect(deferred.getAttribute("style")).toContain("min-block-size:24rem");
    // Its photos and island are inert markup until the browser moves them in.
    const template = deferred.querySelector("template") as HTMLTemplateElement;
    expect(template.innerHTML).toContain("scalius-island");
    expect(wall.querySelectorAll(":scope > * img")).toHaveLength(0);
  });

  it("adds its badge and line to every card: the core card's, and the card another app's skin draws", async () => {
    bundle();
    const core = await renderProduct(theme());
    const coreCards = core.page.querySelectorAll('[data-theme-component="product-card"]');
    expect(coreCards.length).toBeGreaterThanOrEqual(2);
    for (const node of coreCards) {
      expect(node.querySelector('.product-card-badges [data-app-slot="product_card.badges"] .compose-badge')?.textContent).toBe("Acme Market");
      expect(node.querySelector('[data-app-slot="product_card.meta"] .compose-line')?.textContent).toBe("Ships from Dhaka");
    }
    const skinned = await renderProduct(theme({ card: true }));
    const studioCards = skinned.page.querySelectorAll('[data-sx-app="acme.studio"] .studio-card');
    expect(studioCards.length).toBeGreaterThanOrEqual(2);
    const ids = Array.from(studioCards).map((node) => node.querySelector(".studio-card-badges .compose-badge")?.getAttribute("data-product"));
    expect(ids).toEqual(expect.arrayContaining(["x2", "x3"]));
    for (const node of studioCards) expect(node.querySelector('[data-app-slot="product_card.meta"] .compose-line')).not.toBeNull();
  });

  it("draws nothing for a failing component, renders the page, and keeps it out of the page cache", async () => {
    bundle();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = await renderProduct(theme());
    expect(failing.response.status).toBe(200);
    expect(failing.page.querySelector('[data-app-slot="header.actions"]')).toBeNull();
    expect(failing.page.querySelector(".compose-header")).not.toBeNull();
    expect(failing.pageDependencies.unproven).toBe(true);
    // Its other components still draw (one failed job fails only itself).
    expect(failing.page.querySelector(".compose-code")).not.toBeNull();
    // The bounded warning names the app (once per isolate; an earlier render may have logged it).
    expect(warn.mock.calls.flat().join(" ")).not.toContain("acme.studio");
    // The same page without that component is proven (storable).
    const healthy = await renderProduct(theme(), [withoutBroken(), studioExtension]);
    expect(healthy.pageDependencies.unproven).toBe(false);
  });

  it("falls back to the store's own unit when an app is slower than its wall time, within it", async () => {
    bundle({ slowStudioMs: 600 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { response, page, pageDependencies, ms } = await renderProduct(theme({ card: true }), [withoutBroken(), studioExtension]);
    expect(response.status).toBe(200);
    // Studio's cards gave way to the core card, which still carries Compose's badge.
    expect(page.querySelector(".studio-card")).toBeNull();
    expect(page.querySelector('[data-theme-component="product-card"] .compose-badge')).not.toBeNull();
    expect(pageDependencies.unproven).toBe(true);
    expect(ms).toBeLessThan(600);
  });
});

// ─── Listing ──────────────────────────────────────────────────────────────

async function renderListing(document: StorefrontThemeDocument) {
  const url = "https://shop.test/categories/phones";
  const queryState = resolveProductListQueryState({ url: new URL(url), facets: [] });
  const html = await runtimeModule.requestRuntime.run({ layout: Promise.resolve({ currency: { code: "BDT", symbol: "৳" }, appExtensions: [withoutBroken(), studioExtension] }) }, () => container.renderToString(ListingPage, {
    props: {
      kind: "category",
      listing: {
        products: [card("x2"), card("x3")], pagination: { page: 1, totalPages: 1, total: 2 }, facets: [], priceRange: { min: 100, max: 900 },
        queryState, pathname: "/categories/phones", resetPath: "/categories/phones", searchLabel: "Search Phones",
        countEndpoint: "/categories/phones/products", currencySymbol: "৳", currencyCode: "BDT",
      },
      hero: { title: "Phones", breadcrumb: [{ label: "Phones", href: "/categories/phones" }], count: 2 },
      childCategories: [
        { id: "cat_cases", name: "Cases", slug: "cases", canonicalPath: null, imageUrl: "https://cdn.shop.test/media/cases.jpg" },
        { id: "cat_chargers", name: "Chargers", slug: "chargers", canonicalPath: "/categories/power", imageUrl: null },
      ],
    },
    locals: { storefrontTheme: Promise.resolve(requestThemeFor(document)) },
    request: new Request(url),
  }));
  return parse(html);
}

describe("a listing skin", () => {
  it("draws the category's children with their photos around the store's filters and page links", async () => {
    bundle();
    const page = await renderListing(theme({ listing: true }));
    const listing = page.querySelector('[data-listing-main="skin"] .compose-listing')!;
    const links = Array.from(listing.querySelectorAll(".compose-departments a"));
    expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([["/categories/cases", "Cases"], ["/categories/power", "Chargers"]]);
    expect(links[0]!.querySelector("img")?.getAttribute("src")).toContain("cases");
    expect(listing.querySelector('[data-sx-embed="filters"]')).not.toBeNull();
    expect(listing.querySelector('[data-sx-embed="pagination"]')).not.toBeNull();
  });

  it("leaves the core grid's cards with every app's card slots", async () => {
    bundle();
    const page = await renderListing(theme());
    const cards = page.querySelectorAll('[data-theme-component="product-card"]');
    expect(cards).toHaveLength(2);
    for (const node of cards) expect(node.querySelector(".compose-badge")).not.toBeNull();
  });
});
