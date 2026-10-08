// @vitest-environment node
/**
 * Installed apps' storefront surfaces through the real pages (Astro container
 * API through a Vite dev server in middleware mode, API stubbed): homepage app
 * sections and their head tags, product page app blocks in their placements
 * (one batch with the product-apps part), app scripts on the pages they name,
 * and proxy pages drawn inside the store layout.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import { storefrontTemplateTheme, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { serializeJsonLd } from "@scalius/shared/plugins/storefront";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string | undefined> }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
let HomePage: unknown;
let ProductPage: unknown;
let ProxyPage: unknown;
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
          name: "app-surfaces-route-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0app-surfaces-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0app-surfaces-test:") ? VIRTUAL_MODULES[id.slice("\0app-surfaces-test:".length)] : undefined,
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
  HomePage = (await server.ssrLoadModule("/src/pages/index.astro")).default;
  ProductPage = (await server.ssrLoadModule("/src/pages/products/[slug].astro")).default;
  ProxyPage = (await server.ssrLoadModule("/src/pages/apps/[pluginId]/[...path].astro")).default;
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

let window = new Window();
afterEach(async () => {
  vi.unstubAllGlobals();
  const previous = window;
  window = new Window();
  await previous.happyDOM.close();
});
const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;

// ─── Stubbed API ──────────────────────────────────────────────────────────

const envelope = (data: unknown) => JSON.stringify({ success: true, data });
const thing = (name: string) => ({ "@context": "https://schema.org", "@type": "Thing", name });
const head = (meta: Array<[string, string, string]>, jsonLd: unknown[] = []) => ({
  meta: meta.map(([attribute, key, content]) => ({ attribute, key, content })),
  jsonLd: jsonLd.map(serializeJsonLd),
});

const APP_SCRIPTS = [
  { pluginId: "acme.reviews", src: "https://cdn.acme.example/product.js", placement: "body-end", pages: ["product"] },
  { pluginId: "acme.chat", src: "https://chat.example/all.js", placement: "head", pages: ["all"] },
  { pluginId: "acme.listing", src: "https://list.example/listing.js", placement: "body-end", pages: ["listing"] },
];

function theme(): StorefrontThemeDocument {
  const document = storefrontTemplateTheme("boutique");
  return {
    ...document,
    pages: {
      ...document.pages,
      home: [
        { id: "greeting", type: "app", version: 1, settings: { app: "acme.hello/greeting", values: { title: "Hi" } } },
        { id: "silent", type: "app", version: 1, settings: { app: "acme.hello/greeting", values: {} } },
        ...document.pages.home,
      ],
    },
  } as StorefrontThemeDocument;
}

function layout() {
  return {
    analytics: [],
    navigation: [],
    footerMenus: [],
    theme: theme(),
    brand: { logo: null, footerLogo: null, favicon: null },
    business: { companyName: "Nakshi Ghor", socialLinks: [] },
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
    policies: [],
    appScripts: APP_SCRIPTS,
  };
}

const HOME_APPS = [
  // Only "greeting" drew something; "silent" is missing and renders nothing.
  { sectionId: "greeting", html: '<div class="greeting"><p>Hello from the app</p></div>', head: head([["name", "hello-verify", "token-1"]], [thing("Greeting")]) },
];

function productData(noIndex: boolean) {
  return {
    product: {
      id: "prod_linen",
      name: "Linen shirt",
      slug: "linen",
      description: "<p>Soft linen.</p>",
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
      imageUrl: null,
      imageAlt: null,
      hasVariants: false,
      availableForSale: true,
      options: [],
      attributes: [],
      features: [],
      noIndex,
      canonicalPath: null,
    },
    category: null,
    media: [],
    variants: [{
      id: "sku_linen",
      productId: "prod_linen",
      optionCombinationKey: "",
      imageId: null,
      imageUrl: null,
      imageMediaId: null,
      selectedOptions: [],
      weight: null,
      sku: "LIN-1",
      price: 1200,
      stock: 5,
      reservedStock: 0,
      availabilityBand: "in_stock",
      isDefault: true,
      trackInventory: true,
      lowStockThreshold: 2,
      barcode: null,
      barcodeType: null,
      discountType: null,
      discountPercentage: null,
      discountAmount: null,
      fulfillmentKind: "physical",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      deletedAt: null,
    }],
    recommendations: { reason: "popular", products: [] },
  };
}

const PRODUCT_BLOCKS = [
  {
    id: "heart",
    app: "acme.wishlist/button",
    placement: "buy-box",
    html: '<form action="/apps/acme.wishlist/toggle" method="post" data-app-form><button type="submit" aria-pressed="false">Save</button></form>',
    head: head([["property", "product:retailer_item_id", "LIN-1"]], [thing("Wishlist")]),
  },
  { id: "note", app: "acme.hello/note", placement: "below", html: "<p>A note below</p>", head: head([]) },
];

interface Stub {
  noIndex?: boolean;
  productApps?: { status: number; blocks?: unknown[] };
  /** What the app answers at `/api/v1/plugins/<id>/public/...`. */
  app?: () => Response;
}

function stubApi(stub: Stub = {}) {
  const calls: string[] = [];
  const pluginCalls: Array<{ url: string; headers: Headers }> = [];
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout()) };
    if (path === "/api/v1/storefront/homepage") {
      return {
        status: 200,
        body: envelope({
          seo: { homepageTitle: null, homepageMetaDescription: null },
          sections: { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null, apps: HOME_APPS },
        }),
      };
    }
    if (path === "/api/v1/products/linen") return { status: 200, body: envelope(productData(stub.noIndex ?? false)) };
    if (path === "/api/v1/storefront/product-apps/linen") {
      const result = stub.productApps ?? { status: 200, blocks: PRODUCT_BLOCKS };
      return result.status === 200
        ? { status: 200, body: envelope({ blocks: result.blocks ?? [] }) }
        : { status: result.status, body: JSON.stringify({ success: false, error: { code: "X", message: "x" } }) };
    }
    if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [] }) };
    if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [] }) };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname.startsWith("/api/v1/plugins/")) {
      pluginCalls.push({ url: `${url.pathname}${url.search}`, headers: new Headers(init?.headers) });
      return stub.app ? stub.app() : new Response("{}", { status: 404 });
    }
    if (url.pathname === "/api/v1/storefront/batch") {
      const parts = url.searchParams.getAll("r").map((part) => {
        const { status, body } = answer(new URL(part, url.origin).pathname);
        return { status, body, contentType: "application/json" };
      });
      return new Response(envelope({ parts }), { headers: { "Content-Type": "application/json" } });
    }
    const { status, body } = answer(url.pathname);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }));
  return { calls, pluginCalls };
}

function runtime() {
  return { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", STOREFRONT_URL: "https://shop.test", inflightReads: new Map() };
}

async function render(component: unknown, request: Request, params?: Record<string, string | undefined>) {
  return runtimeModule.requestRuntime.run(runtime(), () =>
    container.renderToResponse(component, { request, locals: {}, ...(params ? { params } : {}) }),
  );
}

const appScriptSources = (page: Document) =>
  Array.from(page.querySelectorAll("script[data-app-script]")).map((script) => script.getAttribute("src"));

// ─── Homepage ─────────────────────────────────────────────────────────────

describe("homepage app sections", () => {
  it("renders what the app drew, nothing for a section without a drawing, and the head tags in the head", async () => {
    const { calls } = stubApi();
    const response = await render(HomePage, new Request("https://shop.test/"));
    expect(response.status).toBe(200);
    const page = parse(await response.text());

    const sections = Array.from(page.querySelectorAll('[data-home-section="app"]'));
    expect(sections.map((node) => node.getAttribute("data-section-id"))).toEqual(["greeting"]);
    expect(sections[0]!.querySelector('[data-app-section="acme.hello/greeting"] .greeting')?.textContent).toBe("Hello from the app");
    expect(page.querySelector('[data-section-id="silent"]')).toBeNull();

    expect(page.head.querySelector('meta[name="hello-verify"]')?.getAttribute("content")).toBe("token-1");
    const appJsonLd = Array.from(page.head.querySelectorAll('script[type="application/ld+json"][data-app-head]'));
    expect(appJsonLd.map((node) => JSON.parse(node.textContent ?? "{}").name)).toEqual(["Greeting"]);

    // The app scripts for "home" or "all": the listing and product ones stay away.
    expect(appScriptSources(page)).toEqual(["https://chat.example/all.js"]);
    expect(page.head.querySelector('script[data-app-script="acme.chat"]')?.hasAttribute("async")).toBe(true);
    // Still one API call: the drawn sections ride in the homepage part.
    expect(calls.filter((call) => call.startsWith("/api/v1/storefront/batch"))).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

// ─── Product page ─────────────────────────────────────────────────────────

describe("product page app blocks", () => {
  it("reads the blocks in the page's one batch and places them in the buy box and below the modules", async () => {
    const { calls } = stubApi();
    const response = await render(ProductPage, new Request("https://shop.test/products/linen"), { slug: "linen" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-store");
    const html = await response.text();
    const page = parse(html);

    expect(calls).toHaveLength(1);
    const batch = new URL(calls[0]!, "https://api.shop.test");
    expect(batch.pathname).toBe("/api/v1/storefront/batch");
    expect(batch.searchParams.getAll("r")).toContain("/api/v1/storefront/product-apps/linen");

    // Buy box: after the buy buttons, before the delivery and returns facts.
    const buyBox = page.querySelector('[data-app-blocks="buy-box"]')!;
    expect(buyBox).not.toBeNull();
    expect(buyBox.querySelector('[data-app-surface="acme.wishlist/button"] form[data-app-form]')).not.toBeNull();
    const ctas = page.querySelector(".buy-box-ctas")!;
    expect(ctas.compareDocumentPosition(buyBox) & 4).toBeTruthy();
    expect(page.querySelector('[data-app-blocks="below"]')).not.toBeNull();
    expect(page.querySelector('[data-app-blocks="buy-box"] [data-app-surface="acme.hello/note"]')).toBeNull();

    // Below: after every template module, inside a module container without a heading.
    const below = page.querySelector('[data-app-blocks="below"]')!;
    expect(below.querySelector("h2")).toBeNull();
    expect(below.textContent?.trim()).toBe("A note below");
    for (const module of Array.from(page.querySelectorAll("[data-product-module]:not([data-app-blocks])"))) {
      expect(module.compareDocumentPosition(below) & 4, module.getAttribute("data-product-module") ?? "").toBeTruthy();
    }

    // Meta in the head; JSON-LD beside the product's own, which stays.
    expect(page.head.querySelector('meta[property="product:retailer_item_id"]')?.getAttribute("content")).toBe("LIN-1");
    const jsonLd = Array.from(page.querySelectorAll('script[type="application/ld+json"]')).map((node) => JSON.parse(node.textContent ?? "{}"));
    expect(jsonLd.map((entry) => entry["@type"])).toEqual(expect.arrayContaining(["Product", "BreadcrumbList", "Thing"]));
    expect(page.head.querySelector('script[type="application/ld+json"][data-app-head]')).toBeNull();

    // The enhancer ships with the surfaces (once); product and "all" scripts load, the listing one does not.
    expect(html.match(/AppSurface\.astro\?astro&type=script/g)).toHaveLength(1);
    expect(appScriptSources(page)).toEqual(["https://chat.example/all.js", "https://cdn.acme.example/product.js"]);
  });

  it("states no app JSON-LD on a product that is not indexed", async () => {
    stubApi({ noIndex: true });
    const page = parse(await (await render(ProductPage, new Request("https://shop.test/products/linen"), { slug: "linen" })).text());
    expect(page.querySelector('script[type="application/ld+json"][data-app-head]')).toBeNull();
    expect(page.head.querySelector('meta[property="product:retailer_item_id"]')).not.toBeNull();
  });

  it("renders the page without blocks when the read fails, for this request only", async () => {
    stubApi({ productApps: { status: 500 } });
    const response = await render(ProductPage, new Request("https://shop.test/products/linen"), { slug: "linen" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const page = parse(await response.text());
    expect(page.querySelector("[data-app-blocks]")).toBeNull();
    expect(page.querySelector(".buy-box-ctas")).not.toBeNull();
  });

  it("renders no app markup at all when the theme has no blocks", async () => {
    stubApi({ productApps: { status: 200, blocks: [] } });
    const response = await render(ProductPage, new Request("https://shop.test/products/linen"), { slug: "linen" });
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-store");
    const html = await response.text();
    expect(html).not.toContain("data-app-blocks");
    expect(html).not.toContain("AppSurface.astro?astro&type=script");
  });
});

// ─── Proxy pages ──────────────────────────────────────────────────────────

describe("app proxy pages", () => {
  const appJson = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

  it("draws a page answer inside the store layout, sanitized, noindex and uncached", async () => {
    const { pluginCalls } = stubApi({
      app: appJson({
        page: {
          title: "Your wishlist",
          description: "Products you saved",
          html: '<h1>Fake</h1><script>alert(1)</script><p onclick="steal()" style="color:red" id="x">Saved items</p><a href="javascript:alert(1)">bad</a><form action="https://evil.example/x" method="post"><input name="a"></form><form action="/apps/acme.wishlist/toggle" method="post" data-app-form><button type="submit">Remove</button></form>',
          head: { meta: [{ name: "wishlist-verify", content: "v1" }, { name: "robots", content: "index" }], jsonLd: [thing("List")] },
        },
      }),
    });
    const request = new Request("https://shop.test/apps/acme.wishlist/wishlist", {
      headers: { Accept: "text/html,application/xhtml+xml", Cookie: "_ga=1; cs_tok=tok_1" },
    });
    const response = await render(ProxyPage, request, { pluginId: "acme.wishlist", path: "wishlist" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const html = await response.text();
    const page = parse(html);

    expect(page.title).toContain("Your wishlist");
    expect(page.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe("Products you saved");
    expect(page.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex,follow");
    expect(page.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
    expect(page.head.querySelector('meta[name="wishlist-verify"]')?.getAttribute("content")).toBe("v1");
    // Not indexed: no app JSON-LD.
    expect(page.querySelector('script[type="application/ld+json"][data-app-head]')).toBeNull();

    const surface = page.querySelector('[data-app-page="acme.wishlist"] [data-app-surface="acme.wishlist"]')!;
    expect(page.querySelectorAll("h1")).toHaveLength(1);
    expect(page.querySelector("h1")?.textContent).toBe("Your wishlist");
    expect(surface.textContent).toContain("Saved items");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("steal()");
    expect(html).not.toContain("evil.example");
    expect(surface.querySelector("[style], [id], [onclick]")).toBeNull();
    expect(surface.querySelector('form[action="/apps/acme.wishlist/toggle"][data-app-form]')).not.toBeNull();
    // The store's chrome around it, and the "all" app script.
    expect(page.querySelector("header, #main-content")).not.toBeNull();
    expect(appScriptSources(page)).toEqual(["https://chat.example/all.js"]);

    // Only the session cookie reached the API.
    expect(pluginCalls[0]!.url).toBe("/api/v1/plugins/acme.wishlist/public/wishlist");
    expect(pluginCalls[0]!.headers.get("cookie")).toBe("cs_tok=tok_1");
  });

  it("states JSON-LD and a canonical link only for a page the app marks indexable", async () => {
    stubApi({ app: appJson({ page: { title: "Size guide", html: "<p>Sizes</p>", index: true, head: { jsonLd: [thing("Guide")] } } }) });
    const response = await render(
      ProxyPage,
      new Request("https://shop.test/apps/acme.sizes/guide", { headers: { Accept: "text/html" } }),
      { pluginId: "acme.sizes", path: "guide" },
    );
    const page = parse(await response.text());
    expect(page.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(page.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://shop.test/apps/acme.sizes/guide");
    expect(page.head.querySelector('script[type="application/ld+json"][data-app-head]')?.textContent).toContain("Guide");
  });

  it("answers a form post's redirect with a 303 to the same store", async () => {
    stubApi({ app: appJson({ redirect: "/products/linen" }) });
    const request = new Request("https://shop.test/apps/acme.wishlist/toggle", {
      method: "POST",
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Origin: "https://shop.test", Cookie: "cs_tok=tok_1" },
      body: "productId=prod_linen&returnTo=%2Fproducts%2Flinen",
    });
    const response = await render(ProxyPage, request, { pluginId: "acme.wishlist", path: "toggle" });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/products/linen");
  });

  it("passes JSON answers through unchanged", async () => {
    stubApi({ app: appJson({ pressed: true, message: "Saved to your wishlist." }) });
    const request = new Request("https://shop.test/apps/acme.wishlist/toggle", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Origin: "https://shop.test" },
      body: "productId=prod_linen",
    });
    const response = await render(ProxyPage, request, { pluginId: "acme.wishlist", path: "toggle" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ pressed: true, message: "Saved to your wishlist." });
  });

  it("renders the page shell without the app's HTML when it is over its bound", async () => {
    stubApi({ app: appJson({ page: { title: "Huge", html: `<p>${"x".repeat(140 * 1024)}</p>` } }) });
    const response = await render(
      ProxyPage,
      new Request("https://shop.test/apps/acme.big/page", { headers: { Accept: "text/html" } }),
      { pluginId: "acme.big", path: "page" },
    );
    const page = parse(await response.text());
    expect(page.querySelector("[data-app-surface]")).toBeNull();
    expect(page.querySelector("[data-app-page-unavailable]")).not.toBeNull();
  });
});
