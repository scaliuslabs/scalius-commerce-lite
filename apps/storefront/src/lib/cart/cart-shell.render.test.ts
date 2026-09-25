// @vitest-environment node
/**
 * The cart page is a buyer-agnostic shell that the edge caches under the
 * store's cache generation (lib/cache-policy.ts `isBuyerShellPathname`). This
 * renders the real pages/cart.astro (Astro container API through a Vite dev
 * server in middleware mode) against a stubbed API and checks what the shared
 * copy promises:
 *
 * - a GET render carries nothing from the request: no cookie, no receipt or
 *   checkout token, no query value, no prefilled buyer field;
 * - two buyers with different cookies and queries get byte-identical HTML;
 * - a render built from a failed read asks never to be stored;
 * - the no-JavaScript cash-on-delivery form still posts to /cart, and a POST
 *   is still handled on the server.
 *
 * The gateway side (canonical key, cookie stripping, browser no-store) is in
 * lib/public-worker-cache.test.ts.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";

interface Container {
  renderToResponse(
    component: unknown,
    options: { request?: Request; locals?: object },
  ): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
let CartPage: unknown;
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
          name: "cart-shell-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0cart-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0cart-test:") ? VIRTUAL_MODULES[id.slice("\0cart-test:".length)] : undefined,
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
  CartPage = (await server.ssrLoadModule("/src/pages/cart.astro")).default;
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

const LAYOUT = {
  analytics: [],
  header: {
    topBar: { text: "", isEnabled: false },
    logo: { src: "", alt: "Nakshi Ghor" },
    favicon: { src: "", alt: "" },
    contact: { phone: "", text: "", isEnabled: false },
    social: [],
  },
  navigation: [],
  footer: { logo: { src: "", alt: "Nakshi Ghor" }, tagline: "", description: "", copyrightText: "", menus: [], social: [] },
  currency: { code: "BDT", symbol: "৳", usdExchangeRate: 120, decimalPlaces: 0 },
  policies: [
    { kind: "terms", title: "Terms", path: "/terms" },
    { kind: "privacy", title: "Privacy policy", path: "/privacy-policy" },
  ],
};
const LANGUAGE = {
  id: "fallback",
  name: "English",
  code: "en",
  languageData: ENGLISH_CHECKOUT_LANGUAGE_DATA,
  fieldVisibility: { showOrderNotesField: true, showAreaField: true },
  isActive: true,
  isDefault: true,
};
const CITIES = [{ id: "city_dhaka", name: "Dhaka" }];
const SHIPPING = { shippingMethods: [{ id: "ship_std", name: "Standard", fee: 60, kind: "delivery" }] };
const COD_CONFIG = {
  gateways: [{ id: "cod", name: "Cash on delivery", flow: "cod" }],
  guestCheckoutEnabled: true,
  checkoutMode: "all",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
  allowedCountries: ["BD"],
  allowedCountriesMode: "include",
  unavailable: false,
};

type Reads = Record<string, { status: number; body: string }>;

function reads(overrides: Reads = {}): Reads {
  return {
    "/api/v1/storefront/layout": { status: 200, body: envelope(LAYOUT) },
    "/api/v1/locations/cities": { status: 200, body: envelope(CITIES) },
    "/api/v1/shipping-methods": { status: 200, body: envelope(SHIPPING) },
    "/api/v1/checkout-languages/active": { status: 200, body: envelope({ language: LANGUAGE }) },
    "/api/v1/checkout/config": { status: 200, body: envelope(COD_CONFIG) },
    ...overrides,
  };
}

/** Answers the storefront batch and single reads; records every call. */
function stubApi(table: Reads) {
  const calls: string[] = [];
  const answer = (path: string) => table[path] ?? { status: 404, body: "{}" };
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

async function renderCart(request: Request, table: Reads = reads()) {
  const calls = stubApi(table);
  const runtime = { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", inflightReads: new Map() };
  const response = await runtimeModule.requestRuntime.run(runtime, () =>
    container.renderToResponse(CartPage, { request, locals: {} }),
  );
  return { response, html: await response.text(), calls };
}

// A buyer's browser request: session, receipt and checkout cookies, a
// tracking cookie, and the quick-buy notice in the query.
const BUYER_COOKIES = [
  "cs_tok=cs_secret_session_token",
  "cs_auth=1",
  "order_receipt=chk_receipt_proof_value",
  "scalius_checkout_status=cst_status_token_value",
  "_fbp=fb.1.1700000000.123456789",
].join("; ");
const buyerRequest = (cookies = BUYER_COOKIES, query = "?quickBuyStorage=blocked&discount=SAVE50") =>
  new Request(`https://shop.test/cart${query}`, {
    headers: { Cookie: cookies, "Accept-Language": "bn", "User-Agent": "buyer-agent" },
  });

describe("the cart shell render", () => {
  it("carries no cookie, token, query value or buyer field, whatever the request holds", async () => {
    const { response, html } = await renderCart(buyerRequest());

    expect(response.status).toBe(200);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(response.headers.get("Cache-Control") ?? "").not.toMatch(/no-store/);
    for (const secret of [
      "cs_secret_session_token",
      "chk_receipt_proof_value",
      "cst_status_token_value",
      "fb.1.1700000000",
      "SAVE50",
      "buyer-agent",
    ]) {
      expect(html, secret).not.toContain(secret);
    }
    // The quick-buy notice is revealed from the URL in the browser.
    expect(html).toMatch(/<div[^>]*id="quickBuyStorageNotice"[^>]*hidden/);
    // Phone is always collected; its submitted value starts empty.
    expect(html).toMatch(/<input type="hidden" name="customerPhone" value=""/);
    // Buyer fields render empty; prefill happens in the browser.
    for (const field of ["customerName", "customerPhone-input", "customerEmail", "shippingAddress"]) {
      const input = html.match(new RegExp(`<(?:input|textarea)[^>]*id="${field}"[^>]*>`))?.[0] ?? "";
      expect(input, field).not.toBe("");
      expect(input, field).not.toMatch(/\svalue="[^"]/);
    }
  });

  it("renders the same bytes for every buyer on the shared lane", async () => {
    // Receipt, checkout-status and tracking cookies keep a buyer on the cached
    // lane (a session cookie does not: lib/cache-policy.ts), and the gateway
    // strips every cookie and query before this render anyway.
    const first = await renderCart(buyerRequest(
      "order_receipt=chk_receipt_proof_value; _fbp=fb.1.1",
      "?quickBuyStorage=blocked",
    ));
    const second = await renderCart(buyerRequest("order_receipt=chk_other; _ga=GA1.1", "?checkoutIssues=1"));
    const anonymous = await renderCart(new Request("https://shop.test/cart"));

    expect(second.html).toBe(first.html);
    expect(anonymous.html).toBe(first.html);
  });

  it("reads only public generation-cached settings, in one batch", async () => {
    const { calls } = await renderCart(buyerRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\/api\/v1\/storefront\/batch\?/);
  });

  it.each([
    ["the layout", "/api/v1/storefront/layout"],
    ["the cities", "/api/v1/locations/cities"],
    ["the delivery methods", "/api/v1/shipping-methods"],
    ["the checkout copy", "/api/v1/checkout-languages/active"],
    ["the checkout settings", "/api/v1/checkout/config"],
  ])("asks never to be stored when %s could not be read", async (_label, path) => {
    const { response } = await renderCart(
      new Request("https://shop.test/cart"),
      reads({ [path]: { status: 503, body: JSON.stringify({ success: false }) } }),
    );

    expect(response.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
  });

  it("keeps a store that is genuinely unavailable cacheable", async () => {
    const { response, html } = await renderCart(
      new Request("https://shop.test/cart"),
      reads({ "/api/v1/checkout/config": { status: 200, body: envelope({ ...COD_CONFIG, gateways: [], unavailable: true }) } }),
    );

    expect(html).toContain('data-checkout-unavailable="true"');
    expect(response.headers.get("Cache-Control") ?? "").not.toMatch(/no-store/);
  });

  it("keeps the no-JavaScript cash-on-delivery form posting to /cart", async () => {
    const { html } = await renderCart(new Request("https://shop.test/cart"));

    const form = html.match(/<form[^>]*id="checkoutForm"[^>]*>/)?.[0] ?? "";
    expect(form).toMatch(/method="POST"/);
    expect(form).toMatch(/action="\/cart"/);
    expect(html).toContain('data-cod-only="true"');
  });

  it("still handles a POST on the server, with the error in the page", async () => {
    const body = new URLSearchParams({ formIntent: "checkout", cartItems: "{}" });
    const { response, html } = await renderCart(
      new Request("https://shop.test/cart", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: BUYER_COOKIES },
      }),
    );

    expect(response.status).toBe(200);
    // The English fallback copy's empty-cart error, rendered server-side.
    expect(html).toMatch(/role="alert"[^>]*>\s*[^<\s][^<]*cart[^<]*</i);
    expect(html).not.toContain("cs_secret_session_token");
  });
});
