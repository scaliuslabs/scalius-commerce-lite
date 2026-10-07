// @vitest-environment node
/**
 * The homepage route against a stubbed API (Astro container API through a
 * Vite dev server in middleware mode): a product homepage answers `/` with
 * its product's own page while the API resolves that product as public, and
 * renders the sections otherwise; under a theme preview the draft's home
 * mode and section data decide.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { storefrontTemplateTheme, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";
const PREVIEW_TOKEN = `tpv_${"p".repeat(48)}`;

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
let HomePage: unknown;
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
          name: "homepage-route-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0home-route-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0home-route-test:") ? VIRTUAL_MODULES[id.slice("\0home-route-test:".length)] : undefined,
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
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Stubbed API ──────────────────────────────────────────────────────────

const envelope = (data: unknown) => JSON.stringify({ success: true, data });

function theme(homeMode: StorefrontThemeDocument["pages"]["homeMode"]): StorefrontThemeDocument {
  const document = storefrontTemplateTheme("boutique");
  return { ...document, pages: { ...document.pages, homeMode } };
}

const SECTIONS_HOME = theme({ kind: "sections" });
const PRODUCT_HOME = theme({ kind: "product", productId: "prod_saree" });

function sections(homeProduct: { id: string; slug: string } | null) {
  return { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct };
}

function layout(document: StorefrontThemeDocument) {
  return {
    analytics: [],
    navigation: [],
    footerMenus: [],
    theme: document,
    brand: { logo: null, footerLogo: null, favicon: null },
    business: { companyName: "Nakshi Ghor", socialLinks: [] },
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
    policies: [],
  };
}

interface Api {
  document: StorefrontThemeDocument;
  homeProduct: { id: string; slug: string } | null;
  markets?: unknown;
  preview?: { document: StorefrontThemeDocument; homeProduct: { id: string; slug: string } | null };
}

/** Answers the storefront batch, single reads and the preview's POSTs; records every call. */
function stubApi(api: Api) {
  const calls: string[] = [];
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") {
      return { status: 200, body: envelope({ ...layout(api.document), ...(api.markets ? { markets: api.markets } : {}) }) };
    }
    if (path === "/api/v1/storefront/homepage") {
      return { status: 200, body: envelope({ seo: { homepageTitle: null, homepageMetaDescription: null }, sections: sections(api.homeProduct) }) };
    }
    if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [] }) };
    if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [] }) };
    if (api.preview && path === "/api/v1/storefront/theme-preview/resolve") {
      return {
        status: 200,
        body: envelope({
          theme: api.preview.document,
          draftRevision: 2,
          basePublishedRevision: 1,
          expiresAt: "2026-10-02T01:00:00.000Z",
          brand: { logo: null, footerLogo: null, favicon: null },
        }),
      };
    }
    if (api.preview && path === "/api/v1/storefront/theme-preview/homepage") {
      return { status: 200, body: envelope(sections(api.preview.homeProduct)) };
    }
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
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
  return calls;
}

async function renderHome(api: Api, cookie?: string, presence?: string) {
  const calls = stubApi(api);
  const runtime = {
    PUBLIC_API_URL: API,
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    STOREFRONT_URL: "https://shop.test",
    inflightReads: new Map(),
    ...(presence ? { MARKET_PRESENCE: presence } : {}),
  };
  const request = new Request("https://shop.test/", cookie ? { headers: { Cookie: cookie } } : {});
  const response = await runtimeModule.requestRuntime.run(runtime, () =>
    container.renderToResponse(HomePage, { request, locals: {} }),
  );
  return { response, calls };
}

describe("the homepage route", () => {
  it("answers a product homepage with a redirect to its public product's own page", async () => {
    const { response } = await renderHome({ document: PRODUCT_HOME, homeProduct: { id: "prod_saree", slug: "jamdani-saree" } });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/products/jamdani-saree");
  });

  it("renders the sections while the product is not public, or names another product", async () => {
    for (const homeProduct of [null, { id: "prod_other", slug: "other" }]) {
      const { response } = await renderHome({ document: PRODUCT_HOME, homeProduct });
      expect(response.status).toBe(200);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).toContain("<h1 class=\"sr-only\">Nakshi Ghor</h1>");
    }
  });

  it("renders the sections in sections mode whatever the section data carries", async () => {
    const { response } = await renderHome({ document: SECTIONS_HOME, homeProduct: { id: "prod_saree", slug: "jamdani-saree" } });
    expect(response.status).toBe(200);
  });

  it("follows the draft's home mode and section data under a theme preview", async () => {
    const cookie = `stp_theme_preview=${PREVIEW_TOKEN}`;
    const draftProduct = await renderHome({
      document: SECTIONS_HOME,
      homeProduct: null,
      preview: { document: PRODUCT_HOME, homeProduct: { id: "prod_saree", slug: "jamdani-saree" } },
    }, cookie);
    expect(draftProduct.response.status).toBe(302);
    expect(draftProduct.response.headers.get("Location")).toBe("/products/jamdani-saree");
    expect(draftProduct.calls).toContain("/api/v1/storefront/theme-preview/homepage");

    // The published product home does not apply to a draft of sections.
    const draftSections = await renderHome({
      document: PRODUCT_HOME,
      homeProduct: { id: "prod_saree", slug: "jamdani-saree" },
      preview: { document: SECTIONS_HOME, homeProduct: null },
    }, cookie);
    expect(draftSections.response.status).toBe(200);
  });
});

describe("the homepage under markets", () => {
  const BACKUP = { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "bn" }] };
  const INDIA = { id: "mkt_in", handle: "india", name: "India", isBackup: false, countries: ["IN"], presences: [{ value: "en-in", locale: "en" }] };

  it("adds nothing while the store has one presence", async () => {
    const plain = await (await renderHome({ document: SECTIONS_HOME, homeProduct: null })).response.text();
    const single = await (await renderHome({ document: SECTIONS_HOME, homeProduct: null, markets: { markets: [BACKUP] } })).response.text();
    expect(single).toBe(plain);
    expect(single).not.toContain("hreflang");
    expect(single).not.toContain("data-market-presence");
    expect(single).not.toContain("data-market-selector");
  });

  it("names every presence with hreflang and offers the selector once there are two", async () => {
    const html = await (await renderHome({ document: SECTIONS_HOME, homeProduct: null, markets: { markets: [BACKUP, INDIA] } })).response.text();
    expect(html).toContain('<link rel="alternate" hreflang="bn-BD" href="https://shop.test/">');
    expect(html).toContain('<link rel="alternate" hreflang="en-IN" href="https://shop.test/en-in">');
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://shop.test/">');
    expect(html).toMatch(/<form method="post" action="\/localization"[^>]*data-market-selector/);
    // The root page speaks the store default language (the root presence's, which hreflang names).
    expect(html).toMatch(/<html lang="bn"/);
    expect(html).toMatch(/<option value="BD" selected[^>]*>বাংলাদেশ \(BDT\)<\/option><option value="IN"[^>]*>ভারত \(BDT\)<\/option>/);
    expect(html).toContain('name="return_to" value="/"');
    expect(html).toContain("data-market-suggestion");
  });

  it("renders a presence page in its language, with its own canonical URL and market-keyed reads", async () => {
    const { response, calls } = await renderHome({ document: SECTIONS_HOME, homeProduct: null, markets: { markets: [BACKUP, INDIA] } }, undefined, "en-in");
    const html = await response.text();
    expect(html).toMatch(/<html lang="en" data-market-presence="en-in"/);
    expect(html).toContain('<link rel="canonical" href="https://shop.test/en-in">');
    expect(html).toContain('<meta property="og:url" content="https://shop.test/en-in">');
    expect(html).toContain('<meta property="og:locale" content="en_IN">');
    expect(html).toContain('"url":"https://shop.test/en-in"');
    expect(html).toContain('"urlTemplate":"https://shop.test/en-in/search?q={search_term_string}"');
    // Only the market-keyed reads carry the presence (the checkout config, the
    // homepage, whose cards are priced in the market, and the layout, whose
    // menus are in the presence's language): one batch, invariant parts unchanged.
    const batch = calls.find((call) => call.startsWith("/api/v1/storefront/batch"))!;
    const parts = new URL(batch, "https://api.shop.test").searchParams.getAll("r");
    expect(parts).toContain("/api/v1/checkout/config?presence=en-in");
    expect(parts).toContain("/api/v1/storefront/layout?presence=en-in");
    expect(parts).toContain("/api/v1/storefront/homepage?presence=en-in");
  });
});
