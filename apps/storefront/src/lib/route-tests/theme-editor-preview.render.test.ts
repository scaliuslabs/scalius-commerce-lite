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
const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";
const PREVIEW_TOKEN = `tpv_${"p".repeat(48)}`;
const PREVIEW_COOKIE = `stp_theme_preview=${PREVIEW_TOKEN}`;

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; params?: Record<string, string> }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
let HomePage: unknown;
let SectionPage: unknown;
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
  HomePage = (await server.ssrLoadModule("/src/pages/index.astro")).default;
  SectionPage = (await server.ssrLoadModule("/src/pages/theme-preview/section.astro")).default;
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

/** The platform origins (Platform settings) every live store has; the baseline was captured without them. */
const PLATFORM = { apiUrl: "https://api.shop.test", storefrontUrl: "https://shop.test", dashboardUrl: "https://admin.shop.test" };

function layout(document: StorefrontThemeDocument, platform: boolean) {
  return {
    ...(platform ? { platform: PLATFORM } : {}),
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
  /** Platform origins in the layout (always with a preview). */
  platform?: boolean;
}

function stubApi(api: Api) {
  const calls: string[] = [];
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout(api.document, api.platform === true || api.preview !== undefined)) };
    if (path === "/api/v1/storefront/homepage") {
      return { status: 200, body: envelope({ seo: { homepageTitle: null, homepageMetaDescription: null }, sections: sectionData() }) };
    }
    if (path.startsWith("/api/v1/storefront/landing/")) {
      const slug = path.split("/").at(-1)!;
      const landing = api.document.pages.landing[slug];
      return landing ? { status: 200, body: envelope({ landing, sections: sectionData() }) } : { status: 404, body: "{}" };
    }
    if (path.startsWith("/api/v1/storefront/pages/slug/")) {
      const slug = path.split("/").at(-1)!;
      const landing = api.document.pages.landing[slug];
      return { status: 200, body: envelope({ page: { id: "cms_campaign", title: "CMS campaign", slug, content: "<p>Original CMS body</p>", noIndex: true,
      }, ...(landing?.overrideCms ? { template: { landing, sections: sectionData() } } : {}) }) };
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

async function renderPage(component: unknown, api: Api, options: { cookie?: string; url?: string; headers?: Record<string, string> } = {}) {
  const calls = stubApi(api);
  const runtime = {
    PUBLIC_API_URL: API,
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    DASHBOARD_URL: "https://admin.shop.test",
    inflightReads: new Map(),
  };
  const headers = { ...options.headers, ...(options.cookie ? { Cookie: options.cookie } : {}) };
  const request = new Request(options.url ?? "https://shop.test/", { headers });
  const response = await runtimeModule.requestRuntime.run(runtime, () =>
    container.renderToResponse(component, { request, locals: {}, params: { slug: new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "" } }),
  );
  return { response, calls, html: await response.text() };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("a buyer's homepage", () => {
  it("is byte-identical to the captured baseline for a fixed theme", async () => {
    const { response, html } = await renderPage(HomePage, { document: fixedTheme() });
    expect(response.status).toBe(200);
    // Dev-server module paths name this checkout: the snapshot names none.
    await expect(html.replaceAll(root, "/@storefront/").replaceAll(repoRoot, "/@repo/")).toMatchFileSnapshot("./__snapshots__/homepage-published.html");
  });
});

describe("theme landing pages", () => {
  const campaign = (overrideCms = false) => {
    const document = fixedTheme();
    document.pages.landing.eid = { title: "ঈদের উৎসব", overrideCms, sections: [
      section("editorial", "campaign", { heading: "ঈদের অফার", body: "Made in Bangladesh." }),
      { ...section("editorial", "hidden", { heading: "Hidden copy", body: "Should not render" }), hidden: true },
      section("faq", "campaign-faq", { heading: "Campaign questions", items: [{ question: "Delivery?", answer: "Across Bangladesh." }] }),
    ] };
    return document;
  };

  it("renders published landing sections in one batch, in order, without hidden copy", async () => {
    const result = await renderPage(LandingPage, { document: campaign(), platform: true }, { url: "https://shop.test/pages/eid" });
    expect(result.response.status).toBe(200);
    expect(result.html).toContain("ঈদের অফার");
    expect(result.html).not.toContain("Hidden copy");
    expect(result.html.indexOf("ঈদের অফার")).toBeLessThan(result.html.indexOf("Campaign questions"));
    expect(result.html).toContain('href="https://shop.test/pages/eid"');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain("/api/v1/storefront/batch?");
    expect(result.html).not.toContain("data-theme-section-id");
  });

  it("previews a draft-only landing page and its individual sections privately", async () => {
    const preview = campaign();
    const result = await renderPage(LandingPage, { document: fixedTheme(), preview }, { cookie: PREVIEW_COOKIE, url: "https://shop.test/pages/eid" });
    expect(result.response.status).toBe(200);
    expect(marked(result.html)).toEqual(["campaign", "campaign-faq"]);
    expect(result.response.headers.get("Cache-Control")).toContain("no-store");
    const partial = await renderPage(SectionPage, { document: fixedTheme(), preview }, { cookie: PREVIEW_COOKIE, url: "https://shop.test/theme-preview/section?id=campaign&page=eid" });
    expect(partial.response.status).toBe(200);
    expect(marked(partial.html)).toEqual(["campaign"]);
    expect(partial.html).toContain("ঈদের অফার");
  });

  it("overrides a published CMS body while retaining its title and noIndex rules", async () => {
    const result = await renderPage(CmsPage, { document: campaign(true), platform: true }, { url: "https://shop.test/eid" });
    expect(result.response.status).toBe(200);
    expect(result.html).toContain("CMS campaign");
    expect(result.html).toContain("ঈদের অফার");
    expect(result.html).not.toContain("<p>Original CMS body</p>");
    expect(result.html).toContain('content="noindex,follow"');
    expect(result.calls).toHaveLength(1);
    const plain = await renderPage(CmsPage, { document: campaign(false), platform: true }, { url: "https://shop.test/eid" });
    expect(plain.html).toContain("Original CMS body");
    expect(plain.html).not.toContain("ঈদের অফার");
  });

  it("returns 404 for absent landing pages", async () => {
    const result = await renderPage(LandingPage, { document: fixedTheme() }, { url: "https://shop.test/pages/absent" });
    expect(result.response.status).toBe(404);
  });
});

/** The page's layout statement (or a section unit's), as the bridge compares them. */
const layoutOf = (html: string) => /data-theme-preview-layout="([^"]*)"/.exec(html)?.[1];
const marked = (html: string) => [...html.matchAll(/ data-theme-section-id="([a-z0-9][a-z0-9_-]*)"/g)].map((match) => match[1]);

describe("a theme preview of the homepage", () => {
  it("marks every section and carries the bridge for the dashboard origin, only under a valid preview", async () => {
    const buyer = await renderPage(HomePage, { document: fixedTheme() });
    for (const marker of ["data-theme-section-id", "data-theme-preview-layout", "scalius-theme-preview", "admin.shop.test"]) {
      expect(buyer.html).not.toContain(marker);
    }

    // A cookie the API does not know renders the published theme, unmarked.
    const stale = await renderPage(HomePage, { document: fixedTheme(), platform: true }, { cookie: PREVIEW_COOKIE });
    expect(stale.html).not.toContain("data-theme-section-id");
    expect(stale.html).not.toContain("scalius-theme-preview");

    const preview = await renderPage(HomePage, { document: fixedTheme(), preview: fixedTheme() }, { cookie: PREVIEW_COOKIE });
    expect(preview.response.status).toBe(200);
    expect(marked(preview.html)).toEqual(["hero", "usp", "rail", "banner-a", "banner-b", "story", "faq", "seo"]);
    expect(layoutOf(preview.html)).toBeDefined();
    // The bridge talks to the dashboard origin only; it names no token.
    expect(preview.html).toContain("scalius-theme-preview");
    expect(preview.html).toContain(JSON.stringify("https://admin.shop.test"));
    expect(preview.html).not.toContain(PREVIEW_TOKEN);
    expect(preview.response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("tells the merchant browsing the storefront in a tab that a draft shows, with a way out; never buyers or the editor's frame", async () => {
    const bar = "data-theme-preview-bar";
    const tab = await renderPage(HomePage, { document: fixedTheme(), preview: fixedTheme() }, { cookie: PREVIEW_COOKIE, headers: { "Sec-Fetch-Dest": "document" } });
    expect(tab.html).toContain(bar);
    expect(tab.html).toContain("Previewing unpublished theme");
    expect(tab.html).toMatch(/<form method="post" action="\/theme-preview\/exit"[^>]*>/);
    expect(tab.response.headers.get("Cache-Control")).toContain("no-store");

    const framed = await renderPage(HomePage, { document: fixedTheme(), preview: fixedTheme() }, { cookie: PREVIEW_COOKIE, headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(framed.html).not.toContain(bar);
    expect((await renderPage(HomePage, { document: fixedTheme() })).html).not.toContain(bar);
    expect((await renderPage(HomePage, { document: fixedTheme(), platform: true }, { cookie: PREVIEW_COOKIE })).html).not.toContain(bar);
  });
});

describe("the preview section route", () => {
  const sectionUrl = (id: string) => `https://shop.test/theme-preview/section?id=${id}`;
  const draft = () => ({ document: fixedTheme(), preview: fixedTheme() });

  it("refuses without a valid preview, and never lets a response be stored", async () => {
    const anonymous = await renderPage(SectionPage, draft(), { url: sectionUrl("story") });
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.response.headers.get("Cache-Control")).toContain("no-store");
    expect(anonymous.calls.some((call) => call.includes("theme-preview"))).toBe(false);

    const stale = await renderPage(SectionPage, { document: fixedTheme() }, { cookie: PREVIEW_COOKIE, url: sectionUrl("story") });
    expect(stale.response.status).toBe(401);
    expect(stale.response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(stale.calls).not.toContain("/api/v1/storefront/theme-preview/homepage");

    expect((await renderPage(SectionPage, draft(), { cookie: PREVIEW_COOKIE, url: sectionUrl("..%2Fx") })).response.status).toBe(400);
    expect((await renderPage(SectionPage, draft(), { cookie: PREVIEW_COOKIE, url: sectionUrl("nope") })).response.status).toBe(404);
  });

  it("renders one section of the draft with the homepage's renderers and layout statement", async () => {
    const page = await renderPage(HomePage, draft(), { cookie: PREVIEW_COOKIE });
    const story = await renderPage(SectionPage, draft(), { cookie: PREVIEW_COOKIE, url: sectionUrl("story") });
    expect(story.response.status).toBe(200);
    expect(story.response.headers.get("Cache-Control")).toContain("no-store");
    expect(story.response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(story.html).not.toContain("<html");
    expect(story.html).toContain("data-theme-preview-unit");
    expect(marked(story.html)).toEqual(["story"]);
    expect(story.html).toContain("Our story");
    // The same unit the page rendered, under the same layout statement.
    expect(layoutOf(story.html)).toBe(layoutOf(page.html));
    const unit = story.html.slice(story.html.indexOf("<div", story.html.indexOf("data-theme-preview-unit")), story.html.lastIndexOf("</div>"));
    expect(unit.length).toBeGreaterThan(0);
    expect(page.html).toContain(unit);
    expect(story.calls).toContain("/api/v1/storefront/theme-preview/homepage");
  });

  it("renders a grouped banner's whole row, each banner marked", async () => {
    const banner = await renderPage(SectionPage, draft(), { cookie: PREVIEW_COOKIE, url: sectionUrl("banner-b") });
    expect(banner.response.status).toBe(200);
    expect(marked(banner.html)).toEqual(["banner-a", "banner-b"]);
  });

  it("states another layout once a change moved the page", async () => {
    const page = await renderPage(HomePage, draft(), { cookie: PREVIEW_COOKIE });
    const document = fixedTheme();
    const moved = { ...document, pages: { ...document.pages, home: [document.pages.home[6]!, ...document.pages.home.filter((_, index) => index !== 6)] } };
    const story = await renderPage(SectionPage, { document, preview: moved }, { cookie: PREVIEW_COOKIE, url: sectionUrl("story") });
    expect(layoutOf(story.html)).not.toBe(layoutOf(page.html));
  });
});
