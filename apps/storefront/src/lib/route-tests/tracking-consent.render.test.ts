// @vitest-environment node
/**
 * Audit spec S4 acceptance (a): an EEA-market page whose buyer has not
 * consented makes no Meta or TikTok request, and Google's Consent Mode
 * defaults are denied. The homepage renders through the real Layout (Astro
 * container API, stubbed API) with a Meta Pixel, a TikTok Pixel and a GA4
 * tag; the HTML then runs in happy-dom, whose fetch interceptor captures
 * every request the page's scripts make. Accepting in the banner starts the
 * pixels (the positive control). A notice market grants by default.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import { storefrontTemplateTheme } from "@scalius/shared/storefront-theme";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";

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
          name: "tracking-consent-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0consent-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0consent-test:") ? VIRTUAL_MODULES[id.slice("\0consent-test:".length)] : undefined,
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

const META_PIXEL = "<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','123456789012345');fbq('track','PageView');</script><noscript><img height=\"1\" width=\"1\" style=\"display:none\" src=\"https://www.facebook.com/tr?id=123456789012345&ev=PageView&noscript=1\"/></noscript>";
const TIKTOK_PIXEL = "<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.load=function(e){var s=d.createElement('script');s.async=!0;s.src='https://analytics.tiktok.com/i18n/pixel/events.js?sdkid='+e;d.head.appendChild(s)};ttq.page=function(){};ttq.load('C4ABCDEF0123456789');ttq.page();}(window,document,'ttq');</script>";
const GA4_TAG = "<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-TEST1234');</script>";

const BACKUP = { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "en" }] };
const GERMANY = { id: "mkt_de", handle: "germany", name: "Germany", isBackup: false, countries: ["DE"], presences: [{ value: "en-de", locale: "en" }] };

function layout() {
  return {
    analytics: [
      { id: "an_meta", type: "facebook_pixel", usePartytown: false, config: META_PIXEL, location: "head" },
      { id: "an_tiktok", type: "tiktok_pixel", usePartytown: false, config: TIKTOK_PIXEL, location: "body_end" },
      { id: "an_ga4", type: "google_analytics", usePartytown: false, config: GA4_TAG, location: "head" },
    ],
    navigation: [],
    footerMenus: [],
    theme: storefrontTemplateTheme("boutique"),
    brand: { logo: null, footerLogo: null, favicon: null },
    business: { companyName: "Nakshi Ghor", socialLinks: [] },
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
    policies: [],
    markets: { markets: [BACKUP, GERMANY] },
    metaCapi: { browserEventsEnabled: false },
    tracking: { consentOtherRegions: "notice", serverEvents: false, tiktokBrowserEvents: false },
  };
}

const envelope = (data: unknown) => JSON.stringify({ success: true, data });

function stubApi() {
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout()) };
    if (path === "/api/v1/storefront/homepage") {
      return { status: 200, body: envelope({ seo: { homepageTitle: null, homepageMetaDescription: null }, sections: { lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null } }) };
    }
    if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [] }) };
    if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [] }) };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
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
}

async function renderPage(presence: string | null): Promise<string> {
  stubApi();
  const runtime = {
    PUBLIC_API_URL: API,
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    STOREFRONT_URL: "https://shop.test",
    inflightReads: new Map(),
    ...(presence ? { MARKET_PRESENCE: presence } : {}),
  };
  const request = new Request(`https://shop.test/${presence ?? ""}`);
  const response = await runtimeModule.requestRuntime.run(runtime, () =>
    container.renderToResponse(HomePage, { request, locals: {} }),
  );
  expect(response.status).toBe(200);
  return await response.text();
}

/** The page in a browser that runs its inline scripts; every request is captured, none leaves. */
async function browse(html: string, url: string) {
  const requests: string[] = [];
  const window = new Window({
    url,
    settings: {
      disableCSSFileLoading: true,
      enableJavaScriptEvaluation: true,
      enableImageFileLoading: true,
      fetch: {
        interceptor: {
          async beforeAsyncRequest({ request, window: requester }) {
            requests.push(request.url);
            return new requester.Response("", { status: 200, headers: { "Content-Type": "application/javascript" } });
          },
          beforeSyncRequest({ request }) {
            requests.push(request.url);
            return { status: 200, statusText: "OK", ok: true, url: request.url, redirected: false, headers: new window.Headers(), body: Buffer.from("") } as never;
          },
        },
      },
    },
  });
  // Only the page's own markup and inline scripts: module bundles (/_astro, /@vite) never load here.
  const page = html.replace(/<script type="module"[\s\S]*?<\/script>/g, "");
  window.document.write(page);
  await window.happyDOM.waitUntilComplete();
  return { window, requests };
}

const thirdParty = (requests: string[], pattern: RegExp) => requests.filter((url) => pattern.test(url));
const META_OR_TIKTOK = /facebook\.(?:net|com)|tiktok\.com/;

describe("tracking consent on an EEA market page (audit spec S4 (a))", () => {
  it("makes no Meta or TikTok request before consent, and Google's Consent Mode defaults are denied", async () => {
    const html = await renderPage("en-de");
    // The noscript pixel is gone (nobody can consent without JavaScript), and the snippets are inert.
    expect(html).not.toMatch(/<noscript><img[^>]*facebook\.com\/tr/);
    expect(html).toContain('data-scalius-consent="marketing"');
    expect(html).toContain('id="scalius-consent"');
    expect(html).toContain('data-regime="opt_in"');

    const { window, requests } = await browse(html, "https://shop.test/en-de");
    expect(thirdParty(requests, META_OR_TIKTOK)).toEqual([]);
    const page = window as unknown as { fbq?: unknown; dataLayer?: unknown[][]; __scaliusConsent?: Record<string, unknown> };
    expect(page.fbq).toBeUndefined();
    expect(page.__scaliusConsent).toMatchObject({ analytics: false, marketing: false, saleOfData: false, source: "default", regime: "opt_in" });
    const consentDefault = page.dataLayer?.map((entry) => Array.from(entry as ArrayLike<unknown>))
      .find((entry) => entry[0] === "consent" && entry[1] === "default");
    expect(consentDefault?.[2]).toMatchObject({
      ad_storage: "denied",
      analytics_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      wait_for_update: 500,
    });
    // The default is the first thing Google's tag reads.
    expect(Array.from(page.dataLayer![0] as ArrayLike<unknown>).slice(0, 2)).toEqual(["consent", "default"]);
    // The banner shows on first paint.
    expect(window.document.documentElement.hasAttribute("data-consent-banner")).toBe(true);
    expect(window.document.cookie).not.toContain("_fbc");

    // Accepting starts both pixels and updates Google's consent.
    (window.document.querySelector('[data-consent-action="accept"]') as unknown as { click(): void }).click();
    await window.happyDOM.waitUntilComplete();
    expect(thirdParty(requests, /connect\.facebook\.net\/en_US\/fbevents\.js/)).toHaveLength(1);
    expect(thirdParty(requests, /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/)).toHaveLength(1);
    expect(window.document.cookie).toContain("scalius_consent=v1-a1-m1-s1");
    expect(window.document.documentElement.hasAttribute("data-consent-banner")).toBe(false);
    const update = page.dataLayer?.map((entry) => Array.from(entry as ArrayLike<unknown>))
      .find((entry) => entry[0] === "consent" && entry[1] === "update");
    expect(update?.[2]).toMatchObject({ ad_storage: "granted", analytics_storage: "granted" });
    await window.happyDOM.close();
  }, 60_000);

  it("keeps the pixels off on a later page after Reject all", async () => {
    const html = await renderPage("en-de");
    const { window, requests } = await browse(html, "https://shop.test/en-de");
    (window.document.querySelector('[data-consent-action="reject"]') as unknown as { click(): void }).click();
    expect(window.document.cookie).toContain("scalius_consent=v1-a0-m0-s0");
    const cookie = window.document.cookie;
    await window.happyDOM.close();

    const next = new Window({ url: "https://shop.test/en-de", settings: { disableCSSFileLoading: true, enableJavaScriptEvaluation: true, enableImageFileLoading: true } });
    next.document.cookie = cookie.split("; ").find((part) => part.startsWith("scalius_consent="))!;
    const captured: string[] = [];
    next.happyDOM.settings.fetch.interceptor = {
      async beforeAsyncRequest({ request }) {
        captured.push(request.url);
        return new next.Response("", { status: 200 });
      },
    };
    next.document.write(html.replace(/<script type="module"[\s\S]*?<\/script>/g, ""));
    await next.happyDOM.waitUntilComplete();
    expect(thirdParty([...requests, ...captured], META_OR_TIKTOK)).toEqual([]);
    expect(next.document.documentElement.hasAttribute("data-consent-banner")).toBe(false);
    await next.happyDOM.close();
  }, 60_000);

  it("grants by default in a notice market and loads the pixels at once", async () => {
    const html = await renderPage(null);
    expect(html).toContain('data-regime="notice"');
    const { window, requests } = await browse(html, "https://shop.test/");
    expect(thirdParty(requests, /connect\.facebook\.net\/en_US\/fbevents\.js/)).toHaveLength(1);
    const page = window as unknown as { dataLayer?: unknown[][] };
    const consentDefault = page.dataLayer?.map((entry) => Array.from(entry as ArrayLike<unknown>))
      .find((entry) => entry[0] === "consent" && entry[1] === "default");
    expect(consentDefault?.[2]).toMatchObject({ ad_storage: "granted", analytics_storage: "granted" });
    await window.happyDOM.close();
  }, 60_000);
});
