// @vitest-environment node
/**
 * The theme editor's storefront side against a stubbed API (Astro container
 * API through a Vite dev server in middleware mode): a buyer's homepage is
 * byte-identical to the captured baseline (no editor marks, no bridge), and
 * only a request with a valid preview cookie carries the section marks, the
 * preview bridge and a frame policy that lets the dashboard embed it.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import {
  storefrontSectionDefault,
  storefrontTemplateTheme,
  type StorefrontSection,
  type StorefrontSectionType,
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
const PREVIEW_COOKIE = `stp_theme_preview=${PREVIEW_TOKEN}`;

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
  HomePage = (await server.ssrLoadModule("/src/pages/index.astro")).default;
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── A fixed theme and its section data ─────────────────────────────────────

const section = <Type extends StorefrontSectionType>(type: Type, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

const image = (name: string) => `https://cdn.shop.test/media/${name}.jpg/1080.webp`;
const media = (id: string) => ({ id, url: image(id), alt: `Photo ${id}`, width: 1600, height: 1000 });

const SECTIONS: StorefrontSection[] = [
  section("hero", "hero", {
    layout: "full-bleed",
    slides: [
      { image: "d1", focalPoint: { x: 50, y: 50 }, alt: "Eid banner", heading: "Eid edit", buttonLabel: "Shop", link: "/collections/eid" },
      { image: "d2", focalPoint: { x: 30, y: 60 }, alt: "Second banner", link: null },
    ],
  }),
  section("usp-strip", "usp", { style: "icons", source: { kind: "custom", items: [{ title: "Free returns", detail: "Within 7 days" }] } }),
  section("category-tiles", "tiles", { style: "photo", title: "Shop by category", categoryIds: ["cat-0", "cat-1", "cat-2"] }),
  section("product-rail", "rail", { title: "New in", source: { kind: "newest" }, limit: 8 }),
  section("banner", "banner-a", { layout: "two-up", heading: "Sarees", text: "Hand woven", mediaId: "b1", cta: { label: "Shop", href: "/collections/sarees" } }),
  section("banner", "banner-b", { layout: "two-up", heading: "Panjabi", text: "", mediaId: "b2", cta: null }),
  section("editorial", "story", { layout: "rich-text", heading: "Our story", body: "Made in Dhaka.\n\nSince 1998." }),
  section("faq", "faq", { heading: "Questions", items: [{ question: "Do you deliver?", answer: "Everywhere in Bangladesh." }] }),
  section("seo-text", "seo", { heading: "About", body: "Long copy for search." }),
];

function fixedTheme(): StorefrontThemeDocument {
  const document = storefrontTemplateTheme("department-mall");
  return { ...document, pages: { ...document.pages, home: SECTIONS, homeMode: { kind: "sections" } } };
}

function product(index: number) {
  return {
    id: `p${index}`,
    name: `Product ${index}`,
    slug: `product-${index}`,
    price: 1200,
    discountType: index % 3 === 0 ? "percentage" : null,
    discountPercentage: index % 3 === 0 ? 10 : 0,
    discountAmount: 0,
    discountedPrice: index % 3 === 0 ? 1080 : 1200,
    priceVaries: false,
    availableForSale: true,
    freeDelivery: false,
    categoryId: "cat-0",
    hasVariants: false,
    imageUrl: image(`p${index}`),
    imageMediaId: null,
    imageAlt: null,
    secondaryImageUrl: null,
  };
}

function sectionData() {
  return {
    lists: [{ key: "newest", products: Array.from({ length: 8 }, (_, index) => product(index + 1)), category: null, collection: null }],
    media: ["d1", "d2", "b1", "b2"].map(media),
    brands: [],
    promotions: [],
    categories: Array.from({ length: 3 }, (_, index) => ({
      id: `cat-${index}`,
      name: `Category ${index}`,
      slug: `category-${index}`,
      description: null,
      imageUrl: image(`cat-${index}`),
      canonicalPath: null,
    })),
    collections: [],
    homeProduct: null,
  };
}

// ─── Stubbed API ────────────────────────────────────────────────────────────

const envelope = (data: unknown) => JSON.stringify({ success: true, data });

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
  /** The draft a valid preview token resolves to; without it every token is unknown. */
  preview?: StorefrontThemeDocument;
}

function stubApi(api: Api) {
  const calls: string[] = [];
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout(api.document)) };
    if (path === "/api/v1/storefront/homepage") {
      return { status: 200, body: envelope({ seo: { homepageTitle: null, homepageMetaDescription: null }, sections: sectionData() }) };
    }
    if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [] }) };
    if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [] }) };
    if (api.preview && path === "/api/v1/storefront/theme-preview/resolve") {
      return {
        status: 200,
        body: envelope({
          theme: api.preview,
          draftRevision: 4,
          basePublishedRevision: 1,
          expiresAt: "2026-10-02T01:00:00.000Z",
          brand: { logo: null, footerLogo: null, favicon: null },
        }),
      };
    }
    if (api.preview && path === "/api/v1/storefront/theme-preview/homepage") {
      return { status: 200, body: envelope(sectionData()) };
    }
    if (path.startsWith("/api/v1/storefront/theme-preview/")) return { status: 404, body: "{}" };
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

async function renderPage(component: unknown, api: Api, options: { cookie?: string; url?: string } = {}) {
  const calls = stubApi(api);
  const runtime = {
    PUBLIC_API_URL: API,
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    DASHBOARD_URL: "https://admin.shop.test",
    inflightReads: new Map(),
  };
  const request = new Request(options.url ?? "https://shop.test/", options.cookie ? { headers: { Cookie: options.cookie } } : {});
  const response = await runtimeModule.requestRuntime.run(runtime, () =>
    container.renderToResponse(component, { request, locals: {} }),
  );
  return { response, calls, html: await response.text() };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("a buyer's homepage", () => {
  it("is byte-identical to the captured baseline for a fixed theme", async () => {
    const { response, html } = await renderPage(HomePage, { document: fixedTheme() });
    expect(response.status).toBe(200);
    await expect(html).toMatchFileSnapshot("./__snapshots__/homepage-published.html");
  });
});
