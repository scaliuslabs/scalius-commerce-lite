// @vitest-environment node
/**
 * Installed apps' storefront surfaces through the real pages (Astro container
 * API through a Vite dev server in middleware mode, API stubbed): app scripts
 * on the pages they name, and proxy pages drawn inside the store layout by
 * the app's own page component (the SDK's runtime, through the real render
 * host). Component sections, slots and skins have their own render tests.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import { storefrontTemplateTheme, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

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
  // The apps' page components, built with the SDK and served as bundled modules.
  const sdk = await server.ssrLoadModule(fileURLToPath(new URL("../../../../../packages/plugin-sdk/src/storefront/index.ts", import.meta.url))) as {
    defineStorefront(definition: unknown): unknown;
    html(strings: TemplateStringsArray, ...values: unknown[]): unknown;
    raw(value: string): unknown;
  };
  const { html, raw } = sdk;
  const bundled = (await server.ssrLoadModule("/src/extensions/bundled.gen.ts")).BUNDLED_STOREFRONT_EXTENSIONS as Record<string, unknown>;
  const register = (pluginId: string, components: Record<string, (props: { props: Record<string, unknown> }) => unknown>) => {
    const module = sdk.defineStorefront({ components });
    bundled[pluginId] = { release: RELEASE, module: async () => ({ default: module }), files: async () => ({}) };
  };
  register("acme.wishlist", {
    wishlist_page: ({ props }) => html`<ul>${(props.items as Array<{ name: string }>).map((item) => html`<li class="wishlist-item">${item.name}</li>`)}</ul>
      <form action="/apps/acme.wishlist/toggle" method="post" data-app-form><button type="submit">Remove</button></form>
      <form action="/cart/add" method="post"><input name="variant" value="v1"></form>`,
  });
  register("acme.sizes", { guide: () => html`<p>Sizes</p><script type="application/ld+json">${raw(JSON.stringify({ "@context": "https://schema.org", "@type": "Thing", name: "Guide" }))}</script>` });
  register("acme.big", { big: ({ props }) => html`<p>${String(props.text)}</p>` });
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

const APP_SCRIPTS = [
  { pluginId: "acme.reviews", src: "https://cdn.acme.example/product.js", placement: "body-end", pages: ["product"] },
  { pluginId: "acme.chat", src: "https://chat.example/all.js", placement: "head", pages: ["all"] },
  { pluginId: "acme.listing", src: "https://list.example/listing.js", placement: "body-end", pages: ["listing"] },
];

const RELEASE = "e".repeat(64);
const pageExtension = (pluginId: string, type: string) => ({
  pluginId, version: "1.0.0", source: "bundled", release: RELEASE, sections: [], sectionSettings: {}, skins: [],
  components: [{ type, targets: ["page"], settings: [] }], islands: [], stylesheet: false, connect: [],
});

function theme(): StorefrontThemeDocument {
  return storefrontTemplateTheme("boutique");
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
    appExtensions: [pageExtension("acme.wishlist", "wishlist_page"), pageExtension("acme.sizes", "guide"), pageExtension("acme.big", "big")],
  };
}


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

interface Stub {
  noIndex?: boolean;
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
          sections: { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null, apps: [] },
        }),
      };
    }
    if (path === "/api/v1/products/linen") return { status: 200, body: envelope(productData(stub.noIndex ?? false)) };
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

// ─── App scripts ──────────────────────────────────────────────────────────

describe("app scripts on public pages", () => {
  it("loads the scripts that name the home page or all, and nothing else", async () => {
    const { calls } = stubApi();
    const response = await render(HomePage, new Request("https://shop.test/"));
    expect(response.status).toBe(200);
    const page = parse(await response.text());
    expect(appScriptSources(page)).toEqual(["https://chat.example/all.js"]);
    expect(page.head.querySelector('script[data-app-script="acme.chat"]')?.hasAttribute("async")).toBe(true);
    expect(page.querySelector("[data-app-slot]")).toBeNull();
    // One API call: the page's batch.
    expect(calls).toHaveLength(1);
  });

  it("loads the product and all scripts on a product page, in one batch, and draws no route-drawn block", async () => {
    const { calls } = stubApi();
    const response = await render(ProductPage, new Request("https://shop.test/products/linen"), { slug: "linen" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-store");
    const html = await response.text();
    const page = parse(html);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!, "https://api.shop.test").searchParams.getAll("r").join(" ")).not.toContain("product-apps");
    expect(appScriptSources(page)).toEqual(["https://chat.example/all.js", "https://cdn.acme.example/product.js"]);
    expect(html).not.toContain("data-app-slot");
    expect(html).not.toContain("AppSurface.astro?astro&type=script");
  });
});

// ─── Proxy pages ──────────────────────────────────────────────────────────

describe("app proxy pages", () => {
  const appJson = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

  it("draws a page answer inside the store layout with the app's component, escaped, noindex and uncached", async () => {
    const { pluginCalls } = stubApi({
      app: appJson({
        page: {
          title: "Your wishlist",
          description: "Products you saved",
          component: "wishlist_page",
          props: { items: [{ name: "Saved items" }, { name: '<img src=x onerror="steal()"><script>alert(1)</script>' }] },
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

    const body = page.querySelector('[data-app-page="acme.wishlist"] [data-app-page-body] [data-sx-app="acme.wishlist"]')!;
    expect(page.querySelectorAll("h1")).toHaveLength(1);
    expect(page.querySelector("h1")?.textContent).toBe("Your wishlist");
    // The buyer's text is text: the component's runtime escaped it.
    const items = [...body.querySelectorAll(".wishlist-item")].map((item) => item.textContent);
    expect(items).toEqual(["Saved items", '<img src=x onerror="steal()"><script>alert(1)</script>']);
    expect(body.querySelector("img, script")).toBeNull();
    // Forms post only to the app's own routes.
    expect(body.querySelector('form[action="/apps/acme.wishlist/toggle"][data-app-form]')).not.toBeNull();
    expect(body.querySelector('form[action="/cart/add"]')).toBeNull();
    // The store's chrome around it, and the "all" app script.
    expect(page.querySelector("header, #main-content")).not.toBeNull();
    expect(appScriptSources(page)).toEqual(["https://chat.example/all.js"]);

    // Only the session cookie reached the API.
    expect(pluginCalls[0]!.url).toBe("/api/v1/plugins/acme.wishlist/public/wishlist");
    expect(pluginCalls[0]!.headers.get("cookie")).toBe("cs_tok=tok_1");
  });

  it("states JSON-LD and a canonical link only for a page the app marks indexable", async () => {
    stubApi({ app: appJson({ page: { title: "Size guide", component: "guide", index: true, head: { jsonLd: [thing("Guide")] } } }) });
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

  it("renders the page shell without the app's markup when its component is missing, and a large answer whole", async () => {
    stubApi({ app: appJson({ page: { title: "Gone", component: "nothing_here" } }) });
    const missing = parse(await (await render(
      ProxyPage,
      new Request("https://shop.test/apps/acme.big/page", { headers: { Accept: "text/html" } }),
      { pluginId: "acme.big", path: "page" },
    )).text());
    expect(missing.querySelector("[data-app-page-body]")).toBeNull();
    expect(missing.querySelector("[data-app-page-unavailable]")).not.toBeNull();
    stubApi({ app: appJson({ page: { title: "Huge", component: "big", props: { text: "x".repeat(60 * 1024) } } }) });
    const response = await render(
      ProxyPage,
      new Request("https://shop.test/apps/acme.big/page", { headers: { Accept: "text/html" } }),
      { pluginId: "acme.big", path: "page" },
    );
    const page = parse(await response.text());
    expect(page.querySelector("[data-app-page-body] p")?.textContent).toHaveLength(60 * 1024);
  });
});
