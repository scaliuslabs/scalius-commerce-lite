// @vitest-environment node
/**
 * The newsletter pages against a stubbed API (Astro container API through a
 * Vite dev server in middleware mode): /newsletter shows the outcome flag a
 * form post or link landed with; /newsletter/confirm and
 * /newsletter/unsubscribe never change anything on GET (mail scanners open
 * links), post the token in the body, answer with only the outcome in the
 * URL, accept a mail client's RFC 8058 one-click (as the gateway hands it
 * on), send no referrer, load no analytics and are never cached.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";
import { storefrontBlockDefault, storefrontTemplateTheme } from "@scalius/shared/storefront-theme";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";
const CONFIRM_TOKEN = "C".repeat(43);
const UNSUBSCRIBE_TOKEN = `u1.Y3VzdF8x.email.${"s".repeat(43)}`;

interface Container {
  renderToResponse(component: unknown, options: { request?: Request; locals?: object }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
let pages: { result: unknown; confirm: unknown; unsubscribe: unknown };
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
          name: "newsletter-route-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0newsletter-route-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0newsletter-route-test:") ? VIRTUAL_MODULES[id.slice("\0newsletter-route-test:".length)] : undefined,
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
  pages = {
    result: (await server.ssrLoadModule("/src/pages/newsletter/index.astro")).default,
    confirm: (await server.ssrLoadModule("/src/pages/newsletter/confirm.astro")).default,
    unsubscribe: (await server.ssrLoadModule("/src/pages/newsletter/unsubscribe.astro")).default,
  };
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
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";

// ─── Stubbed API ──────────────────────────────────────────────────────────

const envelope = (data: unknown) => JSON.stringify({ success: true, data });
const ANALYTICS = { id: "ga", type: "google-analytics", usePartytown: false, location: "head", config: "<script>window.__gaLoaded=1</script>" };

/** A theme whose footer is the newsletter-grey one (it has its own signup form). */
function themeWithNewsletterFooter() {
  const theme = storefrontTemplateTheme("boutique");
  theme.blocks.footer = storefrontBlockDefault("footer", "newsletter-grey") as never;
  return theme;
}

function layout(languageCode: string) {
  return {
    analytics: [ANALYTICS],
    navigation: [],
    footerMenus: [],
    theme: themeWithNewsletterFooter(),
    brand: { logo: null, footerLogo: null, favicon: null },
    business: { companyName: "Nakshi Ghor", socialLinks: [] },
    currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
    policies: [],
    storefrontCopy: { languageCode },
  };
}

interface Call {
  path: string;
  body: unknown;
  authorization: string | null;
}

/** Answers the layout read, the system JWT and the marketing routes; records every marketing call. */
function stubApi(options: { languageCode?: string; marketing?: Record<string, { status: number; body: unknown }> } = {}) {
  const calls: Call[] = [];
  const answer = (path: string): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") return { status: 200, body: envelope(layout(options.languageCode ?? "en")) };
    if (path === "/api/v1/auth/token") return { status: 200, body: envelope({ token: "system-jwt" }) };
    const marketing = options.marketing?.[path];
    if (marketing) return { status: marketing.status, body: JSON.stringify(marketing.body) };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.startsWith("/api/v1/marketing/")) {
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "null")), authorization: headers.get("Authorization") });
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

async function renderPage(page: unknown, request: Request) {
  const runtime = { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", API_TOKEN: "storefront-api-token", inflightReads: new Map() };
  return runtimeModule.requestRuntime.run(runtime, () => container.renderToResponse(page, { request, locals: {} }));
}

function formPost(url: string, fields: Record<string, string>, origin = "https://shop.test") {
  return new Request(url, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("/newsletter", () => {
  it("says a finished outcome with a way back to the store, never cached or indexed", async () => {
    stubApi();
    const response = await renderPage(pages.result, new Request("https://shop.test/newsletter?status=pending"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const page = parse(await response.text());
    expect(text(page.querySelector("h1"))).toBe("Check your email");
    expect(page.querySelector('meta[name="robots"]')!.getAttribute("content")).toContain("noindex");
    expect(page.querySelector('main a[href="/"]')).not.toBeNull();
    expect(page.querySelector("form[data-newsletter-form]")).toBeNull();
  });

  it("shows the form again after a refusal, and on its own without a status", async () => {
    stubApi();
    const refused = parse(await (await renderPage(pages.result, new Request("https://shop.test/newsletter?status=invalid"))).text());
    expect(text(refused.querySelector("h1"))).toBe("Check your details");
    expect(refused.querySelector('[role="alert"]')).not.toBeNull();
    expect(refused.querySelector('form[action="/api/newsletter/subscribe"]')).not.toBeNull();
    // The newsletter-grey footer leaves its own form out here: one signup per page.
    expect(refused.querySelectorAll("form[data-newsletter-form]")).toHaveLength(1);

    stubApi({ languageCode: "bn" });
    const plain = parse(await (await renderPage(pages.result, new Request("https://shop.test/newsletter?status=%3Cscript%3E"))).text());
    expect(text(plain.querySelector("h1"))).toBe("নতুন খবর ও অফার পান");
    expect(plain.documentElement.getAttribute("lang")).toBe("bn");
  });
});

describe("/newsletter/confirm", () => {
  it("asks before confirming: GET calls no marketing route and posts the token in the body", async () => {
    const calls = stubApi();
    const response = await renderPage(pages.confirm, new Request(`https://shop.test/newsletter/confirm?token=${CONFIRM_TOKEN}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const html = await response.text();
    expect(calls).toEqual([]);
    const page = parse(html);
    const form = page.querySelector('main form[method="post"]')!;
    expect(form.getAttribute("action")).toBe("/newsletter/confirm");
    expect(form.querySelector('input[type="hidden"][name="token"]')!.getAttribute("value")).toBe(CONFIRM_TOKEN);
    expect(text(form.querySelector("button"))).toBe("Confirm subscription");
    // No analytics on a page whose URL carries a token.
    expect(html).not.toContain("__gaLoaded");
    expect(html).toContain("history.replaceState");
  });

  it("shows a dead link without a form", async () => {
    const calls = stubApi();
    const page = parse(await (await renderPage(pages.confirm, new Request("https://shop.test/newsletter/confirm?token=short"))).text());
    expect(text(page.querySelector("h1"))).toBe("This link no longer works");
    expect(page.querySelector('main form[method="post"]')).toBeNull();
    expect(calls).toEqual([]);
  });

  it("confirms on POST and redirects with only the outcome", async () => {
    const calls = stubApi({ marketing: { "/api/v1/marketing/confirm": { status: 200, body: { success: true, data: { status: "confirmed" } } } } });
    const response = await renderPage(pages.confirm, formPost("https://shop.test/newsletter/confirm", { token: CONFIRM_TOKEN }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/newsletter?status=confirmed");
    expect(calls).toEqual([{ path: "/api/v1/marketing/confirm", body: { token: CONFIRM_TOKEN }, authorization: "Bearer system-jwt" }]);
  });

  it("refuses a cross-site post", async () => {
    const calls = stubApi();
    const response = await renderPage(pages.confirm, formPost("https://shop.test/newsletter/confirm", { token: CONFIRM_TOKEN }, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("/newsletter/unsubscribe", () => {
  const PREVIEW = { "/api/v1/marketing/unsubscribe/preview": { status: 200, body: { success: true, data: { valid: true, channel: "email", status: "subscribed", contactMasked: "r•••@example.com" } } } };
  const DONE = { "/api/v1/marketing/unsubscribe": { status: 200, body: { success: true, data: { status: "unsubscribed", channel: "email" } } } };

  it("asks first: GET only previews and shows the masked address", async () => {
    const calls = stubApi({ marketing: PREVIEW });
    const response = await renderPage(pages.unsubscribe, new Request(`https://shop.test/newsletter/unsubscribe?token=${UNSUBSCRIBE_TOKEN}`));
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const html = await response.text();
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/marketing/unsubscribe/preview"]);
    const page = parse(html);
    expect(text(page.querySelector("main"))).toContain("Stop email messages to r•••@example.com?");
    const form = page.querySelector('main form[method="post"]')!;
    expect(form.getAttribute("action")).toBe("/newsletter/unsubscribe");
    expect(form.querySelector('input[name="token"]')!.getAttribute("value")).toBe(UNSUBSCRIBE_TOKEN);
    expect(html).not.toContain("__gaLoaded");
  });

  it("speaks Bangla in a Bangla store", async () => {
    stubApi({ languageCode: "bn", marketing: PREVIEW });
    const page = parse(await (await renderPage(pages.unsubscribe, new Request(`https://shop.test/newsletter/unsubscribe?token=${UNSUBSCRIBE_TOKEN}`))).text());
    expect(text(page.querySelector("main"))).toContain("r•••@example.com-এ ইমেইল বার্তা পাঠানো বন্ধ করবেন?");
    expect(text(page.querySelector("main form button"))).toBe("আনসাবস্ক্রাইব করুন");
  });

  it("unsubscribes on the page's POST and redirects with only the outcome", async () => {
    const calls = stubApi({ marketing: DONE });
    const response = await renderPage(pages.unsubscribe, formPost("https://shop.test/newsletter/unsubscribe", { token: UNSUBSCRIBE_TOKEN }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/newsletter?status=unsubscribed");
    expect(calls).toEqual([{ path: "/api/v1/marketing/unsubscribe", body: { token: UNSUBSCRIBE_TOKEN }, authorization: "Bearer system-jwt" }]);
  });

  it("takes a mail client's one-click unsubscribe (as the gateway hands it on) with the URL's token", async () => {
    const calls = stubApi({ marketing: DONE });
    const response = await renderPage(pages.unsubscribe, new Request(`https://shop.test/newsletter/unsubscribe?token=${UNSUBSCRIBE_TOKEN}`, {
      method: "POST",
      body: JSON.stringify({ "List-Unsubscribe": "One-Click" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(await response.text()).toBe("You're unsubscribed.");
    expect(calls).toEqual([{ path: "/api/v1/marketing/unsubscribe", body: { token: UNSUBSCRIBE_TOKEN }, authorization: "Bearer system-jwt" }]);

    // Any other JSON body is not a one-click.
    const other = await renderPage(pages.unsubscribe, new Request(`https://shop.test/newsletter/unsubscribe?token=${UNSUBSCRIBE_TOKEN}`, {
      method: "POST",
      body: JSON.stringify({ unsubscribe: true }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(other.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("says a dead link is dead", async () => {
    const calls = stubApi({ marketing: { "/api/v1/marketing/unsubscribe/preview": { status: 200, body: { success: true, data: { valid: false, channel: null, status: null, contactMasked: null } } } } });
    const page = parse(await (await renderPage(pages.unsubscribe, new Request(`https://shop.test/newsletter/unsubscribe?token=${UNSUBSCRIBE_TOKEN}`))).text());
    expect(text(page.querySelector("h1"))).toBe("This link no longer works");
    expect(page.querySelector('main form[method="post"]')).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
