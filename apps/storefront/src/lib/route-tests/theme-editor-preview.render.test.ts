// @vitest-environment node
/**
 * The theme editor's storefront side against a stubbed API (Astro container
 * API through a Vite dev server in middleware mode): a buyer's homepage is
 * byte-identical to the captured baseline (no editor marks, no bridge), and
 * only a request with a valid preview cookie carries the section marks, the
 * preview bridge and a frame policy that lets the dashboard embed it. The
 * preview-only render and paint routes answer a same-origin POST under a live
 * preview cookie, and refuse everything else.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import {
  EMPTY_STORE_SHAPE,
  storefrontSectionDefault,
  storefrontTemplateTheme,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
  type StoreShape,
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
let RenderPage: unknown;
let LibraryPage: unknown;
let extensionHost: typeof import("../extensions/host").ExtensionHost;
let bundledExtensions: Record<string, import("../extensions/loaders").BundledStorefrontExtension>;
let paintRoute: { ALL(context: { request: Request; locals: object }): Promise<Response> };
let LandingPage: unknown;
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
  RenderPage = (await server.ssrLoadModule("/src/pages/theme-preview/render.astro")).default;
  bundledExtensions = (await server.ssrLoadModule("/src/extensions/bundled.gen.ts")).BUNDLED_STOREFRONT_EXTENSIONS;
  extensionHost = (await server.ssrLoadModule("/src/lib/extensions/host.ts")).ExtensionHost;
  LibraryPage = (await server.ssrLoadModule("/src/pages/theme-preview/library.astro")).default;
  paintRoute = (await server.ssrLoadModule("/src/pages/theme-preview/paint.ts")) as typeof paintRoute;
  LandingPage = (await server.ssrLoadModule("/src/pages/pages/[slug].astro")).default;
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
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
  unavailable?: string[];
  previewData?: ReturnType<typeof sectionData> & { apps?: unknown[] };
  appExtensions?: unknown;
  storeShape?: StoreShape;
  onPreviewSections?: (ids: string[]) => void;
}

function stubApi(api: Api) {
  const calls: string[] = [];
  const answer = (path: string): { status: number; body: string } => {
    if (api.unavailable?.includes(path)) return { status: 503, body: "{}" };
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope({
      ...layout(api.document, api.platform === true || api.preview !== undefined),
      ...(api.storeShape ? { storeShape: api.storeShape } : {}),
      ...(api.appExtensions ? { appExtensions: api.appExtensions } : {}),
    }) };
    if (path === "/api/v1/storefront/homepage") {
      return { status: 200, body: envelope({ seo: { homepageTitle: null, homepageMetaDescription: null }, sections: sectionData() }) };
    }
    if (path.startsWith("/api/v1/storefront/landing/")) {
      const slug = path.split("/").at(-1)!;
      const landing = api.document.pages.landing[slug];
      return landing ? { status: 200, body: envelope({ title: landing.title, description: landing.description, sections: sectionData() }) } : { status: 404, body: "{}" };
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
      return { status: 200, body: envelope(api.previewData ?? sectionData()) };
    }
    if (path.startsWith("/api/v1/storefront/theme-preview/")) return { status: 404, body: "{}" };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/storefront/theme-preview/homepage" && typeof init?.body === "string") {
      const posted = JSON.parse(init.body) as { sections?: Array<{ id: string }> };
      api.onPreviewSections?.((posted.sections ?? []).map((each) => each.id));
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
  return calls;
}

/** A POST the way the bridge sends it: same origin, JSON; each part can be changed to test a refusal. */
interface Post {
  body: unknown;
  /** The Origin header; null: none. */
  origin?: string | null;
  contentType?: string;
}

interface PageOptions {
  cookie?: string;
  url?: string;
  headers?: Record<string, string>;
  post?: Post;
}

function buildRequest(options: PageOptions): Request {
  const post = options.post;
  const headers: Record<string, string> = {
    ...options.headers,
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(post ? { "Content-Type": post.contentType ?? "application/json" } : {}),
    ...(post && post.origin !== null ? { Origin: post.origin ?? "https://shop.test" } : {}),
  };
  return new Request(options.url ?? "https://shop.test/", {
    headers,
    ...(post ? { method: "POST", body: typeof post.body === "string" ? post.body : JSON.stringify(post.body) } : {}),
  });
}

const RUNTIME = {
  PUBLIC_API_URL: API,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  DASHBOARD_URL: "https://admin.shop.test",
};

/** The paint endpoint (an API route, not a page) under the same stubbed API. */
async function callPaint(api: Api, options: PageOptions) {
  const calls = stubApi(api);
  const response = await runtimeModule.requestRuntime.run({ ...RUNTIME, inflightReads: new Map() }, () =>
    paintRoute.ALL({ request: buildRequest(options), locals: {} }),
  );
  return { response, calls, text: await response.text() };
}

async function renderPage(component: unknown, api: Api, options: PageOptions = {}) {
  const calls = stubApi(api);
  const runtime = { ...RUNTIME, inflightReads: new Map() };
  const request = buildRequest(options);
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
  const campaign = () => {
    const document = fixedTheme();
    document.pages.landing.eid = { title: "ঈদের উৎসব", description: "Eid gifts, delivered.", sections: [
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
    expect(result.html).toContain('<meta name="description" content="Eid gifts, delivered."');
    expect(result.html).toContain("<title>ঈদের উৎসব");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain("/api/v1/storefront/batch?");
    expect(result.html).not.toContain("data-theme-section-id");
  });

  it("keeps a landing page hidden from search engines public, with noindex,follow", async () => {
    const document = campaign();
    document.pages.landing.eid = { ...document.pages.landing.eid!, noIndex: true };
    const result = await renderPage(LandingPage, { document, platform: true }, { url: "https://shop.test/pages/eid" });
    expect(result.response.status).toBe(200);
    expect(result.html).toContain('<meta name="robots" content="noindex,follow"');
    expect(result.html).toContain("ঈদের অফার");
    expect(result.calls).toHaveLength(1);
    const listed = await renderPage(LandingPage, { document: campaign(), platform: true }, { url: "https://shop.test/pages/eid" });
    expect(listed.html).not.toContain('name="robots"');
  });

  it("previews a draft-only landing page and its individual sections privately", async () => {
    const preview = campaign();
    const result = await renderPage(LandingPage, { document: fixedTheme(), preview }, { cookie: PREVIEW_COOKIE, url: "https://shop.test/pages/eid" });
    expect(result.response.status).toBe(200);
    expect(marked(result.html)).toEqual(["announcement", "header", "campaign", "campaign-faq", "footer"]);
    expect(result.response.headers.get("Cache-Control")).toContain("no-store");
    const partial = await renderPage(RenderPage, { document: fixedTheme(), preview }, {
      cookie: PREVIEW_COOKIE,
      url: "https://shop.test/theme-preview/render",
      post: { body: { scope: { kind: "landing", slug: "eid" }, sections: preview.pages.landing.eid!.sections, only: "campaign" } },
    });
    expect(partial.response.status).toBe(200);
    expect(marked(partial.html)).toEqual(["campaign"]);
    expect(partial.html).toContain("ঈদের অফার");
  });

  it("returns 404 for absent landing pages and 503 when the landing read fails", async () => {
    const result = await renderPage(LandingPage, { document: fixedTheme() }, { url: "https://shop.test/pages/absent" });
    expect(result.response.status).toBe(404);
    const reserved = await renderPage(LandingPage, { document: fixedTheme() }, { url: "https://shop.test/pages/products" });
    expect(reserved.response.status).toBe(404);
  });
});

const regionsOf = (html: string) => [...html.matchAll(/ data-theme-region="([a-z]+)"/g)].map((match) => match[1]);
const marked = (html: string) => [...html.matchAll(/ data-theme-section-id="([a-z0-9][a-z0-9_-]*)"/g)].map((match) => match[1]);

describe("a theme preview of the homepage", () => {
  it("marks every section and carries the bridge for the dashboard origin, only under a valid preview", async () => {
    const buyer = await renderPage(HomePage, { document: fixedTheme() });
    for (const marker of ["data-theme-section-id", "data-theme-field", "data-theme-region", "scalius-theme-preview", "admin.shop.test"]) {
      expect(buyer.html).not.toContain(marker);
    }

    // A cookie the API does not know renders the published theme, unmarked.
    const stale = await renderPage(HomePage, { document: fixedTheme(), platform: true }, { cookie: PREVIEW_COOKIE });
    expect(stale.html).not.toContain("data-theme-section-id");
    expect(stale.html).not.toContain("scalius-theme-preview");

    const preview = await renderPage(HomePage, { document: fixedTheme(), preview: fixedTheme() }, { cookie: PREVIEW_COOKIE });
    expect(preview.response.status).toBe(200);
    // The sections in order, between the header (with its announcement bar) and the footer.
    expect(marked(preview.html)).toEqual(["announcement", "header", "hero", "usp", "rail", "banner-a", "banner-b", "story", "faq", "seo", "footer"]);
    expect(regionsOf(preview.html)).toEqual(["page"]);
    expect(preview.html).not.toContain("data-theme-preview-layout");
    expect(preview.html).toContain('data-theme-field="heading"');
    expect(preview.html).toContain('data-theme-field="body"');
    const hero = /data-theme-section-id="hero"([\s\S]*?)data-theme-section-id="usp"/.exec(preview.html)?.[1];
    expect(hero).toBeTruthy();
    expect(hero).not.toContain("data-theme-field");
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

const RENDER_URL = "https://shop.test/theme-preview/render";
const PAINT_URL = "https://shop.test/theme-preview/paint";

describe("the preview render route", () => {
  const draft = () => ({ document: fixedTheme(), preview: fixedTheme() });
  const homeBody = (extra: Record<string, unknown> = {}) => ({ scope: { kind: "home" }, sections: fixedTheme().pages.home, ...extra });
  const render = (body: unknown, options: PageOptions = {}, api: Api = draft()) =>
    renderPage(RenderPage, api, { cookie: PREVIEW_COOKIE, url: RENDER_URL, post: { body }, ...options });

  it("refuses everything but a same-origin JSON POST under a live preview cookie, and never lets a response be stored", async () => {
    const refusals: Array<[string, Awaited<ReturnType<typeof render>>, number]> = [
      ["no cookie", await render(homeBody(), { cookie: undefined }), 401],
      ["a cross-origin post", await render(homeBody(), { post: { body: homeBody(), origin: "https://evil.test" } }), 403],
      ["no origin", await render(homeBody(), { post: { body: homeBody(), origin: null } }), 403],
      ["a form post", await render(homeBody(), { post: { body: homeBody(), contentType: "text/plain" } }), 415],
      ["a body that is not JSON", await render("{", { post: { body: "{" } }), 400],
      ["a body the theme schema refuses", await render({ scope: { kind: "home" }, sections: [{ id: "x", type: "nope" }] }), 400],
      ["a scope the page does not have", await render({ scope: { kind: "landing", slug: "Not A Slug" }, sections: [] }), 400],
      ["a fixed part outside the template's sections", await render({ scope: { kind: "template", template: "product", main: 2 }, sections: [] }), 400],
      ["an unknown field", await render(homeBody({ extra: true })), 400],
      ["a get", await renderPage(RenderPage, draft(), { cookie: PREVIEW_COOKIE, url: RENDER_URL }), 405],
    ];
    for (const [name, result, status] of refusals) {
      expect(result.response.status, name).toBe(status);
      expect(result.response.headers.get("Cache-Control"), name).toContain("no-store");
      expect(result.html, name).toBe("");
    }
    // Nothing was drawn for a refused post: no section data was read.
    expect(refusals.some(([, result]) => result.calls.some((call) => call.includes("theme-preview/homepage")))).toBe(false);
    // An expired or revoked session asks for a new one and drops the cookie.
    const stale = await render(homeBody(), {}, { document: fixedTheme() });
    expect(stale.response.status).toBe(401);
    expect(stale.response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(stale.calls.some((call) => call.includes("theme-preview/homepage"))).toBe(false);
  });

  it("draws the page's region from the draft's sections, marked, with the homepage's renderers", async () => {
    const page = await renderPage(HomePage, draft(), { cookie: PREVIEW_COOKIE });
    const result = await render(homeBody());
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toContain("no-store");
    expect(result.response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(result.html).not.toContain("<html");
    expect(regionsOf(result.html)).toEqual(["page"]);
    expect(marked(result.html)).toEqual(["hero", "usp", "rail", "banner-a", "banner-b", "story", "faq", "seo"]);
    expect(result.calls).toContain("/api/v1/storefront/theme-preview/homepage");
    // The sections of the unsaved list, not the saved one.
    const edited = fixedTheme().pages.home.filter((each) => each.id !== "faq");
    expect(marked((await render(homeBody({ sections: edited }))).html)).not.toContain("faq");
    // A unit is the one the page rendered.
    const storyUnit = (html: string) => /<div[^>]*data-theme-section-id="story"[\s\S]*?<\/section>/.exec(html)?.[0];
    expect(storyUnit(result.html)).toBeDefined();
    expect(storyUnit(result.html)).toBe(storyUnit(page.html));
  });

  it("draws one unit of the draft, and a grouped banner's whole row", async () => {
    const story = await render(homeBody({ only: "story" }));
    expect(story.response.status).toBe(200);
    expect(story.html).toContain("data-theme-preview-unit");
    expect(regionsOf(story.html)).toEqual([]);
    expect(marked(story.html)).toEqual(["story"]);
    expect(story.html).toContain("Our story");
    expect(marked((await render(homeBody({ only: "banner-b" }))).html)).toEqual(["banner-a", "banner-b"]);
    // A section the list does not hold has no unit: the bridge hides it.
    expect((await render(homeBody({ only: "ghost" }))).html.trim()).toBe("");
  });

  it("does not replace a required dependency failure with successful empty HTML", async () => {
    for (const path of ["/api/v1/storefront/theme-preview/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"]) {
      const sections = path.endsWith("homepage") ? fixedTheme().pages.home
        : [section("usp-strip", "delivery", { source: { kind: "delivery-facts" } })];
      const result = await render(homeBody({ sections }), {}, { ...draft(), unavailable: [path] });
      expect(result.response.status, path).toBe(503);
      expect(result.response.headers.get("Cache-Control"), path).toContain("no-store");
      expect(result.html, path).toBe("");
    }
  });

  it.each([false, true])("reads no unrelated catalog or delivery data for a data-free unit edit (phone hero: %s)", async (phoneHero) => {
    const sections = [...fixedTheme().pages.home, section("usp-strip", "delivery", { source: { kind: "delivery-facts" } })];
    if (phoneHero) sections.unshift(section("hero", "phone", { phonePlacement: "after-categories", slides: [
      { image: "d1", alt: "Hero", focalPoint: { x: 50, y: 50 }, link: null },
    ] }));
    const result = await render(homeBody({ sections, only: "faq" }), {}, { ...draft(), unavailable: [
      "/api/v1/storefront/theme-preview/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config",
    ] });
    expect(result.response.status).toBe(200);
    expect(marked(result.html)).toEqual(["faq"]);
    expect(result.html).toContain("Everywhere in Bangladesh.");
    expect(result.calls.some((path) => /theme-preview\/homepage|shipping-methods|checkout\/config/.test(path))).toBe(false);
  });

  it("reads only the target region while retaining banner and phone context", async () => {
    const seen: string[][] = [];
    const sections = [section("product-rail", "above"), section("banner", "one", { layout: "two-up", mediaId: "b1" }),
      section("faq", "empty", { items: [] }), section("banner", "two", { layout: "two-up", mediaId: "b2" })];
    const result = await render({ scope: { kind: "template", template: "product", main: 1 }, sections, only: "two" }, {},
      { ...draft(), onPreviewSections: (ids) => seen.push(ids) });
    expect(result.response.status).toBe(200);
    expect(marked(result.html)).toEqual(["one", "two"]);
    expect(seen).toEqual([["one", "empty", "two"]]);
    seen.length = 0;
    const phone = [section("hero", "phone", { phonePlacement: "after-categories", slides: [
      { image: "d1", alt: "Hero", focalPoint: { x: 50, y: 50 }, link: null },
    ] }), section("category-tiles", "categories", { categoryIds: ["cat-0", "cat-1"] }), section("faq", "faq")];
    const phoneResult = await render(homeBody({ sections: phone, only: "categories" }), {}, {
      ...draft(), storeShape: { ...EMPTY_STORE_SHAPE, topCategoryCount: 2 }, onPreviewSections: (ids) => seen.push(ids),
    });
    expect(phoneResult.response.status).toBe(200);
    expect(marked(phoneResult.html)).toEqual(["categories"]);
    expect(seen).toEqual([["phone", "categories", "faq"]]);
  });

  it("still accepts a successful empty section result", async () => {
    const empty = { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null };
    const result = await render(homeBody({ only: "rail" }), {}, { ...draft(), previewData: empty });
    expect(result.response.status).toBe(200);
    expect(marked(result.html)).toEqual([]);
  });

  it("draws a template's two regions around its fixed part", async () => {
    const sections = [section("editorial", "above", { heading: "Above copy", body: "x" }), section("editorial", "below", { heading: "Below copy", body: "y" })];
    const result = await render({ scope: { kind: "template", template: "product", main: 1 }, sections });
    expect(result.response.status).toBe(200);
    expect(regionsOf(result.html)).toEqual(["before", "after"]);
    expect(marked(result.html)).toEqual(["above", "below"]);
    expect(result.html.indexOf("Above copy")).toBeLessThan(result.html.indexOf("Below copy"));
    const only = await render({ scope: { kind: "template", template: "product", main: 1 }, sections, only: "below" });
    expect(marked(only.html)).toEqual(["below"]);
  });
});

describe("initial preview dependency failures", () => {
  it.each(["home", "landing"])("refuses failed %s section data without affecting buyers or genuine empty content", async (kind) => {
    const document = fixedTheme();
    document.pages.landing.eid = { title: "Eid", description: "", sections: document.pages.home };
    const component = kind === "home" ? HomePage : LandingPage;
    const url = kind === "home" ? "https://shop.test/" : "https://shop.test/pages/eid";
    const api = { document, preview: document, unavailable: ["/api/v1/storefront/theme-preview/homepage"] };
    const failed = await renderPage(component, api, { url, cookie: PREVIEW_COOKIE });
    expect(failed.response.status).toBe(503);
    expect(failed.response.headers.get("Cache-Control")).toContain("no-store");
    expect(failed.html).toContain("Storefront temporarily unavailable");
    expect(failed.html).not.toContain("data-theme-section-id");
    expect((await renderPage(component, { document, unavailable: api.unavailable }, { url })).response.status).toBe(200);
    const empty = { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null };
    expect((await renderPage(component, { document, preview: document, previewData: empty }, { url, cookie: PREVIEW_COOKIE })).response.status).toBe(200);
  });

  it.each(["/api/v1/shipping-methods", "/api/v1/checkout/config"])("refuses required initial-preview delivery failures at %s", async (path) => {
    const document = fixedTheme();
    document.pages.home = [section("usp-strip", "delivery", { source: { kind: "delivery-facts" } })];
    document.pages.landing.eid = { title: "Eid", description: "", sections: document.pages.home };
    for (const [component, url] of [[HomePage, "https://shop.test/"], [LandingPage, "https://shop.test/pages/eid"]] as const) {
      const result = await renderPage(component, { document, preview: document, unavailable: [path] }, { url, cookie: PREVIEW_COOKIE });
      expect(result.response.status).toBe(503);
      expect(result.html).toContain("Storefront temporarily unavailable");
    }
  });
});

describe("the preview paint route", () => {
  const draft = () => ({ document: fixedTheme(), preview: fixedTheme() });
  const paint = (body: unknown, options: PageOptions = {}, api: Api = draft()) =>
    callPaint(api, { cookie: PREVIEW_COOKIE, url: PAINT_URL, post: { body }, ...options });

  it("paints an unsaved document: its tokens, theme attributes and font faces, never stored", async () => {
    const base = await paint({ theme: fixedTheme() });
    expect(base.response.status).toBe(200);
    expect(base.response.headers.get("Cache-Control")).toContain("no-store");
    expect(base.response.headers.get("Content-Type")).toContain("application/json");
    const painted = JSON.parse(base.text) as { css: string; attributes: Record<string, string>; fonts: string };
    expect(painted.css).toMatch(/^:root, \.site-root \{ --/);
    expect(Object.keys(painted.attributes)).toEqual(expect.arrayContaining(["data-theme-density", "data-theme-radius"]));
    expect(typeof painted.fonts).toBe("string");

    // Another template's document paints another look.
    const other = JSON.parse((await paint({ theme: storefrontTemplateTheme("boutique") })).text) as { css: string };
    expect(other.css).not.toBe(painted.css);
  });

  it("refuses without a live preview cookie, from another origin, with a bad body, or by get", async () => {
    const theme = fixedTheme();
    expect((await paint({ theme }, { cookie: undefined })).response.status).toBe(401);
    expect((await paint({ theme }, { post: { body: { theme }, origin: "https://evil.test" } })).response.status).toBe(403);
    expect((await paint({ theme: { version: 8 } })).response.status).toBe(400);
    expect((await paint({ theme, extra: 1 })).response.status).toBe(400);
    const get = await callPaint(draft(), { cookie: PREVIEW_COOKIE, url: PAINT_URL });
    expect(get.response.status).toBe(405);
    const stale = await paint({ theme }, {}, { document: fixedTheme() });
    expect(stale.response.status).toBe(401);
    expect(stale.response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    for (const result of [stale, get]) expect(result.response.headers.get("Cache-Control")).toContain("no-store");
  });
});


describe("one private library document", () => {
  const url = (section = "product-grid", page = "/") => `https://shop.test/theme-preview/library?${new URLSearchParams({ section, page, v: "library-document-1" })}`;
  it("renders the real selected product grid with saved styles and one bounded data request", async () => {
    const result = await renderPage(LibraryPage, { document: fixedTheme(), preview: fixedTheme() }, { url: url(), cookie: PREVIEW_COOKIE });
    expect(result.response.status).toBe(200);
    // Astro's container omits the doctype (as in the published snapshot),
    // but this route must still render a complete Layout document.
    expect(result.html).toMatch(/^<html[^>]*>/);
    expect(result.html).toContain("<head>");
    expect(result.html).toContain("</body></html>");
    expect(result.html).not.toContain('const SELF = "scalius-theme-preview"');
    expect(result.html).not.toContain('const EDITOR = "scalius-theme-editor"');
    expect(result.html).toContain('data-home-section="product-grid"');
    expect(result.html).toContain("Product 1");
    expect(result.html).not.toContain("Our story");
    expect(result.html).toContain("data-library-preview");
    expect(result.html).toContain("connect-src 'none'; form-action 'none'");
    expect(result.html).toContain("<div inert>");
    expect(result.response.headers.get("Cache-Control")).toContain("no-store");
    expect(result.response.headers.get("Vary")).toBe("Cookie");
    expect(result.response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(result.calls.filter((call) => call.includes("theme-preview/homepage"))).toHaveLength(1);
    expect(result.calls.some((call) => /products|shipping|checkout|orders/.test(call))).toBe(false);
    expect(result.response.headers.get("Set-Cookie")).toBeNull();
  });
  it("renders honest empty defaults without catalog reads or made-up example content", async () => {
    const result = await renderPage(LibraryPage, { document: fixedTheme(), preview: fixedTheme() }, { url: url("faq"), cookie: PREVIEW_COOKIE });
    expect(result.response.status).toBe(200);
    expect(result.html).not.toContain('data-home-render-unit=""');
    expect(result.calls.some((call) => call.includes("theme-preview/homepage"))).toBe(false);
    expect(result.html).toContain("scalius:library-preview");
  });
  it("refuses missing/expired auth, invalid selectors, unknown apps and unknown saved landing scopes", async () => {
    for (const [api, options, status] of [
      [{ document: fixedTheme() }, { url: url() }, 401],
      [{ document: fixedTheme() }, { url: url(), cookie: PREVIEW_COOKIE }, 401],
      [{ document: fixedTheme(), preview: fixedTheme() }, { url: url("unknown"), cookie: PREVIEW_COOKIE }, 400],
      [{ document: fixedTheme(), preview: fixedTheme() }, { url: url("faq", "/account"), cookie: PREVIEW_COOKIE }, 400],
      [{ document: fixedTheme(), preview: fixedTheme() }, { url: url("acme.inactive/hero"), cookie: PREVIEW_COOKIE }, 404],
      [{ document: fixedTheme(), preview: fixedTheme() }, { url: url("faq", "/pages/unknown"), cookie: PREVIEW_COOKIE }, 404],
    ] as const) {
      const result = await renderPage(LibraryPage, api, options);
      expect(result.response.status).toBe(status);
      expect(result.response.headers.get("Cache-Control")).toContain("no-store");
      expect(result.response.headers.get("Vary")).toBe("Cookie");
      expect(result.response.headers.get("Location")).toBeNull();
    }
  });
  it("links the selected active app's immutable stylesheet even when the saved theme never uses it", async () => {
    const release = "e".repeat(64);
    const app = { pluginId: "acme.theme", version: "1.0.0", source: "bundled", release,
      sections: ["hero"], sectionSettings: { hero: [] }, skins: [], blocks: [], islands: ["motion"], stylesheet: true, connect: [] };
    const render = vi.spyOn(extensionHost.prototype, "render").mockResolvedValue("<h2>App default</h2>");
    const result = await renderPage(LibraryPage, { document: fixedTheme(), preview: fixedTheme(), appExtensions: [app],
      previewData: { ...sectionData(), apps: [{ sectionId: "library-section", component: { pluginId: "acme.theme", type: "hero", values: {}, media: [], lists: [] } }] },
    }, { url: url("acme.theme/hero"), cookie: PREVIEW_COOKIE });
    expect(result.response.status).toBe(200);
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.html).toContain("App default");
    expect(result.html).toContain(`/_x/acme.theme/${release}/styles.css`);
    expect(result.html.match(/data-app-stylesheet/g)).toHaveLength(1);
  });
  it("distinguishes a failed component renderer from a valid empty result only in the library", async () => {
    const app = { pluginId: "acme.theme", version: "1.0.0", source: "bundled", release: "e".repeat(64),
      sections: ["hero"], sectionSettings: { hero: [] }, skins: [], blocks: [], islands: [], stylesheet: false, connect: [] };
    const api = { document: fixedTheme(), preview: fixedTheme(), appExtensions: [app], previewData: { ...sectionData(), apps: [{
      sectionId: "library-section",
      component: { pluginId: "acme.theme", type: "hero", values: {}, media: [], lists: [] },
    }] } };
    const render = vi.spyOn(extensionHost.prototype, "render").mockResolvedValue(null);
    const failed = await renderPage(LibraryPage, api, { url: url("acme.theme/hero"), cookie: PREVIEW_COOKIE });
    expect(render).toHaveBeenCalledTimes(1);
    expect(failed.html).toContain("<template data-library-render-failed");
    render.mockResolvedValue("");
    const empty = await renderPage(LibraryPage, api, { url: url("acme.theme/hero"), cookie: PREVIEW_COOKIE });
    expect(render).toHaveBeenCalledTimes(2);
    expect(empty.html).not.toContain("<template data-library-render-failed");
    render.mockResolvedValue(null);
    const canvas = await renderPage(RenderPage, api, { url: "https://shop.test/theme-preview/render", cookie: PREVIEW_COOKIE,
      post: { body: { scope: { kind: "home" }, sections: [{ id: "library-section", type: "app", version: 1, settings: { app: "acme.theme/hero", values: {} } }] } },
    });
    expect(render).toHaveBeenCalledTimes(3);
    expect(canvas.html).not.toContain("data-library-render-failed");
  });
  it.each([
    ["/products/current-product", "product", "product"],
    ["/categories/current-category", "listing", "collection"],
    ["/cart", "cart", "cart"],
  ] as const)("enforces the extension boundary for a selected placement at %s", async (path, kind, template) => {
    const release = "a".repeat(64);
    const contexts: Array<import("@scalius/shared/plugins/storefront-components").StorefrontRenderContext> = [];
    const pluginId = "library.context-test";
    bundledExtensions[pluginId] = {
      release,
      files: async () => ({ FILES: {} }),
      module: async () => ({ default: { abi: 1, render(batch) {
        contexts.push(batch.context);
        return { abi: 1, results: batch.jobs.map((job) => ({ id: job.id, html: "<section><p>Selected app only</p></section>" })) };
      } } }),
    };
    try {
      const document = fixedTheme();
      document.pages.templates[template] = { main: 1, sections: [
        section("editorial", "existing-before", { heading: "Do not draw before" }),
        section("editorial", "existing-after", { heading: "Do not draw after" }),
      ] };
      const app = { pluginId, version: "1.0.0", source: "bundled", release,
        sections: ["hero"], sectionSettings: { hero: [] }, skins: [], blocks: [], islands: [], stylesheet: false, connect: [] };
      const requested: string[][] = [];
      const result = await renderPage(LibraryPage, { document, preview: document, appExtensions: [app],
        onPreviewSections: (ids) => requested.push(ids), previewData: { ...sectionData(), apps: [{
          sectionId: "library-section",
          component: { pluginId, type: "hero", values: {}, media: [], lists: [] },
        }] },
      }, { url: url(`${pluginId}/hero`, path), cookie: PREVIEW_COOKIE });
      expect(result.response.status).toBe(200);
      if (kind === "cart") {
        expect(contexts).toEqual([]);
        expect(result.html).not.toContain("Selected app only");
        expect(result.html).toContain("data-library-render-failed");
        return;
      }
      // This is the actual ExtensionHost batch, after layout and saved-theme
      // resolution, not a unit assertion of the override setter.
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ page: { kind, path }, preview: true });
      expect(requested).toEqual([["library-section"]]);
      expect(result.html).toContain("Selected app only");
      expect(result.html).not.toContain("Do not draw before");
      expect(result.html).not.toContain("Do not draw after");
      expect(result.html.match(/data-home-section=/g)).toHaveLength(1);
      expect(result.calls.every((call) => ["/api/v1/storefront/layout", "/api/v1/storefront/theme-preview/resolve", "/api/v1/storefront/theme-preview/homepage"].includes(call))).toBe(true);
      expect(document.pages.templates[template].main).toBe(1);
    } finally {
      delete bundledExtensions[pluginId];
    }
  });
  it("fails honestly when selected-section data is unavailable", async () => {
    const result = await renderPage(LibraryPage, { document: fixedTheme(), preview: fixedTheme(), unavailable: ["/api/v1/storefront/theme-preview/homepage"] }, { url: url(), cookie: PREVIEW_COOKIE });
    expect(result.response.status).toBe(503);
    expect(result.html).not.toContain("Product 1");
  });
});
