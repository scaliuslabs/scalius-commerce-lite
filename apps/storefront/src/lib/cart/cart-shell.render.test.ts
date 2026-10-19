// @vitest-environment node
/**
 * The cart and checkout pages are buyer-agnostic shells that the edge caches
 * like public pages (lib/cache-policy.ts `isBuyerShellPathname`). This
 * renders the real pages/cart.astro and pages/checkout.astro (Astro container API through a Vite dev
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
import { Window } from "happy-dom";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import {
  createOrderReceiptCookieHeader,
  createOrderReceiptFinalizeCookieHeader,
  readOrderReceiptCookie,
  readOrderReceiptFinalizeCookie,
} from "../order-receipt-cookie";

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
let CheckoutPage: unknown;
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
  CheckoutPage = (await server.ssrLoadModule("/src/pages/checkout.astro")).default;
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
  navigation: [],
  footerMenus: [],
  brand: { logo: null, footerLogo: null, favicon: null },
  currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 },
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
const POPULAR = {
  reason: "popular",
  products: [
    { id: "p_linen", slug: "linen-shirt", name: "Linen shirt", imageUrl: "https://cdn.shop.test/media/linen.jpg/1600.webp", discountedPrice: 1250 },
    { id: "p_belt", slug: "belt", name: "Belt", imageUrl: null, discountedPrice: 300 },
  ],
};
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
    "/api/v1/products/recommendations": { status: 200, body: envelope(POPULAR) },
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

async function renderPage(component: unknown, request: Request, table: Reads = reads()) {
  const calls = stubApi(table);
  const runtime = { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", inflightReads: new Map() };
  const response = await runtimeModule.requestRuntime.run(runtime, () =>
    container.renderToResponse(component, { request, locals: {} }),
  );
  return { response, html: await response.text(), calls };
}

const renderCart = (request: Request, table: Reads = reads()) => renderPage(CartPage, request, table);

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

const checkoutPost = () => new Request("https://shop.test/cart", {
  method: "POST",
  body: new URLSearchParams({
    formIntent: "checkout", checkoutId: "checkout_previous_123456", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    customerName: "Buyer", customerPhone: "+8801712345678", shippingAddress: "House 1, Dhaka",
    city: "city_dhaka", zone: "zone_mirpur", shippingLocation: "ship_std",
    cartItems: JSON.stringify({ line_1: { id: "product_1", name: "Tee", price: 100, quantity: 1, variantId: "variant_1" } }),
  }),
});

const checkoutRefusal = (code: string, details?: unknown) => reads({
  "/api/v1/orders/cart-validation": { status: 200, body: envelope({
    valid: true, issues: [], subtotal: 100, hasFreeDeliveryProduct: false,
    items: [{ index: 0, cartKey: "line_1", productId: "product_1", variantId: "variant_1", quantity: 1, unitPrice: 100, productName: "Tee" }],
    delivery: { kind: "delivery", shippingCharge: 60, cityName: "Dhaka", zoneName: "Mirpur" },
  }) },
  "/api/v1/orders": { status: 409, body: JSON.stringify({ success: false, error: { code, details, message: "Checkout needs review" } }) },
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

  it("draws the empty cart's popular products in the shell, with lazy photos a full cart never fetches", async () => {
    const { html, calls } = await renderCart(new Request("https://shop.test/cart"));

    expect(calls).toHaveLength(1);
    const section = html.slice(html.indexOf('id="cartEmptyPopularTitle"'));
    expect(section).toContain('href="/products/linen-shirt"');
    expect(section).toContain("Linen shirt");
    const photo = section.match(/<img[^>]*>/)?.[0] ?? "";
    expect(photo).toMatch(/loading="lazy"/);
    // A DPR 3 phone asks for about 2x pixels.
    expect(photo).toMatch(/sizes="\(min-resolution: 2\.5dppx\) and \(max-width: 639px\)/);
    // Shown only while the cart is empty.
    expect(html.slice(0, html.indexOf('id="cartEmptyPopularTitle"'))).toMatch(/group-data-\[cart-state=empty\]:block[^>]*data-cart-empty-extras/);
  });

  it("leaves the popular products out when they could not be read", async () => {
    const { html } = await renderCart(
      new Request("https://shop.test/cart"),
      reads({ "/api/v1/products/recommendations": { status: 503, body: JSON.stringify({ success: false }) } }),
    );
    expect(html).not.toContain('id="cartEmptyPopularTitle"');
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

  it("shows the merchant's marketing consent box unchecked and optional, in the checkout language, only when on", async () => {
    const consent = (enabled: boolean, code = "en") => reads({
      "/api/v1/checkout/config": { status: 200, body: envelope({
        ...COD_CONFIG,
        marketingConsent: { enabled, channels: ["sms", "email"], label: { en: "Send me news and offers", bn: "আমাকে খবর ও অফার পাঠান" } },
      }) },
      "/api/v1/checkout-languages/active": { status: 200, body: envelope({ language: { ...LANGUAGE, code } }) },
    });
    const { html } = await renderCart(new Request("https://shop.test/cart"), consent(true));
    const box = html.match(/<input[^>]*name="marketingConsent_sms"[^>]*>/)?.[0] ?? "";
    expect(box).toMatch(/type="checkbox"/);
    expect(box).toMatch(/value="en"/);
    expect(box).not.toMatch(/\schecked/);
    expect(box).not.toMatch(/\srequired/);
    expect(html).toContain("Send me news and offers");
    // Inside the checkout form, so a ticked box travels with the order.
    expect(html.indexOf('name="marketingConsent_sms"')).toBeGreaterThan(html.indexOf('id="checkoutForm"'));
    expect(html.indexOf('name="marketingConsent_sms"')).toBeLessThan(html.indexOf('id="submitButton"'));

    const bangla = await renderCart(new Request("https://shop.test/cart"), consent(true, "bn"));
    expect(bangla.html).toContain("আমাকে খবর ও অফার পাঠান");
    expect(bangla.html.match(/<input[^>]*name="marketingConsent_sms"[^>]*>/)?.[0]).toMatch(/value="bn"/);

    const off = await renderCart(new Request("https://shop.test/cart"), consent(false));
    expect(off.html).not.toContain('name="marketingConsent_sms"');
    // Still one batch: the box comes from the checkout settings the page already reads.
    expect(off.calls.filter((call) => !call.startsWith("/api/v1/storefront/batch"))).toEqual([]);
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

  it("refers a conflicting COD checkout to its existing proof-gated receipt without attaching the submitted cart", async () => {
    const { response, calls } = await renderCart(checkoutPost(), checkoutRefusal("CHECKOUT_ATTEMPT_CONFLICT", {
      orderId: "old_order", paymentMethod: "cod", receiptToken: "chk_must_not_be_used",
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/order-success?orderId=old_order&payment=cod");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(readOrderReceiptCookie(cookies[0], "old_order")).toBe("");
    expect(readOrderReceiptFinalizeCookie(cookies[0], "old_order")).toEqual({
      checkoutId: "checkout_previous_123456", cartFingerprintHash: null,
    });
    expect(cookies[0]).not.toContain("chk_must_not_be_used");
    expect(cookies[0]).not.toContain("cartfp_");
    expect(calls.filter((call) => call === "/api/v1/orders")).toHaveLength(1);
  });

  it("only marks the expired submitted checkout for client reset and keeps the cart form available", async () => {
    const { response, html } = await renderCart(checkoutPost(), checkoutRefusal("CHECKOUT_ATTEMPT_EXPIRED"));
    expect(response.status).toBe(200);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(html).toContain('data-expired-checkout-id="checkout_previous_123456"');
    expect(html).toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.checkoutAttemptExpiredText);
    expect(html).toContain('id="checkoutForm"');
  });

  it.each(["CHECKOUT_ATTEMPT_CONFLICT", "STOREFRONT_CHECKOUT_QUOTE_CONFLICT", "CHECKOUT_ATTEMPT_MISSING"])(
    "does not rotate or redirect a %s refusal without a safe existing-order reference", async (code) => {
      const { response, html } = await renderCart(checkoutPost(), checkoutRefusal(code, { orderId: "../../private?token=chk_secret" }));
      expect(response.status).toBe(200);
      expect(response.headers.has("Set-Cookie")).toBe(false);
      expect(html).not.toContain("data-expired-checkout-id");
      expect(html).not.toContain("chk_secret");
      if (code === "CHECKOUT_ATTEMPT_CONFLICT") expect(html).toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.checkoutAttemptConflictText);
    },
  );
});

describe("the checkout shell render", () => {
  const checkoutRequest = (cookies = BUYER_COOKIES, query = "?payment=card&orderId=order_buyer_77&discount=SAVE50") =>
    new Request(`https://shop.test/checkout${query}`, {
      headers: { Cookie: cookies, "Accept-Language": "bn", "User-Agent": "buyer-agent" },
    });
  const renderCheckout = (request: Request, table: Reads = reads()) => renderPage(CheckoutPage, request, table);

  it("carries nothing from the request and gives every buyer the same bytes", async () => {
    const signedIn = await renderCheckout(checkoutRequest());
    expect(signedIn.response.status).toBe(200);
    expect(signedIn.response.headers.has("Set-Cookie")).toBe(false);
    expect(signedIn.response.headers.get("Cache-Control") ?? "").not.toMatch(/no-store/);
    for (const secret of ["cs_secret_session_token", "chk_receipt_proof_value", "cst_status_token_value", "fb.1.1700000000", "SAVE50", "buyer-agent", "order_buyer_77"]) {
      expect(signedIn.html, secret).not.toContain(secret);
    }

    // Receipt, checkout-status and tracking cookies keep a buyer on the shared
    // lane (a session cookie renders live), and the gateway strips every
    // cookie and query before this render anyway.
    const buyer = await renderCheckout(checkoutRequest("order_receipt=chk_receipt_proof_value; scalius_checkout_status=cst_x; _fbp=fb.1.1"));
    const other = await renderCheckout(checkoutRequest("order_receipt=chk_other; _ga=GA1.1", "?token=x"));
    const anonymous = await renderCheckout(new Request("https://shop.test/checkout"));
    expect(other.html).toBe(buyer.html);
    expect(anonymous.html).toBe(buyer.html);
  });

  it("reads only public dependency-validated settings, in one batch", async () => {
    const { calls } = await renderCheckout(checkoutRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\/api\/v1\/storefront\/batch\?/);
  });

  it.each([
    ["the layout", "/api/v1/storefront/layout"],
    ["the checkout copy", "/api/v1/checkout-languages/active"],
    ["the checkout settings", "/api/v1/checkout/config"],
  ])("asks never to be stored when %s could not be read", async (_label, path) => {
    const { response } = await renderCheckout(
      new Request("https://shop.test/checkout"),
      reads({ [path]: { status: 503, body: JSON.stringify({ success: false }) } }),
    );

    expect(response.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
  });

  it("keeps a store that is genuinely unavailable cacheable", async () => {
    const { response } = await renderCheckout(
      new Request("https://shop.test/checkout"),
      reads({ "/api/v1/checkout/config": { status: 200, body: envelope({ ...COD_CONFIG, gateways: [], unavailable: true }) } }),
    );

    expect(response.headers.get("Cache-Control") ?? "").not.toMatch(/no-store/);
  });
});

describe("conflict recovery receipt marker", () => {
  const checkoutId = "checkout_previous_123456";
  const marker = createOrderReceiptFinalizeCookieHeader("old_order", { checkoutId, mode: "attempt-only" })!.split(";")[0];
  const proof = createOrderReceiptCookieHeader("old_order", "chk_private_proof")!.split(";")[0];
  const request = (cookie: string, path = "/order-success") => new Request(`https://shop.test${path}?orderId=old_order&payment=cod`, { headers: { Cookie: cookie } });

  it.each(["absent", "rejected"])("does not expose or consume the marker when receipt proof is %s", async (proofState) => {
    const ReceiptPage = (await server.ssrLoadModule("/src/pages/order-success.astro")).default;
    const { response, html, calls } = await renderPage(ReceiptPage, request(proofState === "absent" ? marker : `${marker}; ${proof}`), reads({
      "/api/v1/orders/receipt/old_order": { status: 404, body: JSON.stringify({ success: false, error: { message: "Receipt unavailable" } }) },
    }));
    expect(response.status).toBe(404);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(html).not.toContain("data-checkout-finalize-id");
    expect(html).not.toContain("data-checkout-finalize-cart-hash");
    expect(html).not.toContain(checkoutId);
    expect(html).not.toContain("chk_private_proof");
    if (proofState === "absent") expect(calls.some((call) => call.includes("/orders/receipt/"))).toBe(false);
  });

  it.each(["/order-success", "/en-in/order-success"])("releases only the matching attempt marker after a real receipt loads at %s", async (path) => {
    const ReceiptPage = (await server.ssrLoadModule("/src/pages/order-success.astro")).default;
    const { response, html } = await renderPage(ReceiptPage, request(`${marker}; ${proof}`, path), reads({
      "/api/v1/orders/receipt/old_order": { status: 200, body: envelope({ order: {
        id: "old_order", orderNumber: 1010, customerName: "Buyer", customerPhone: "+8801712345678", customerEmail: null,
        shippingAddress: "House 1, Dhaka", city: "city_dhaka", zone: "zone_mirpur", area: null,
        totalAmount: 160, shippingCharge: 60, discountAmount: null, paymentMethod: "cod", paymentStatus: "unpaid",
        status: "pending", paidAmount: 0, balanceDue: 160, accountLinked: false,
        createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
        items: [], supportRequests: [], supportRequestActions: [], supportRequestIntro: "Contact the store for help.",
      } }) },
    }));
    expect(response.status).toBe(200);
    expect(html).toContain('data-order-id="old_order"');
    expect(html).toContain(`data-checkout-finalize-id="${checkoutId}"`);
    expect(html).not.toContain("data-checkout-finalize-cart-hash");
    expect(html).not.toContain("chk_private_proof");
    expect(response.headers.getSetCookie()).toEqual([expect.stringContaining("Max-Age=0")]);
    expect(response.headers.getSetCookie()[0]).toContain("Path=/;");
  });

  it("says a payment that could not start failed and offers Try again and the store's other methods", async () => {
    const ReceiptPage = (await server.ssrLoadModule("/src/pages/order-success.astro")).default;
    const bkash = "scalius.bangladesh:bkash";
    const nagad = "scalius.bangladesh:nagad";
    const { response, html } = await renderPage(
      ReceiptPage,
      new Request(`https://shop.test/order-success?orderId=old_order&payment=${encodeURIComponent(bkash)}&result=failed`, { headers: { Cookie: proof } }),
      reads({
        "/api/v1/checkout/config": { status: 200, body: envelope({ ...COD_CONFIG, gateways: [
          ...COD_CONFIG.gateways,
          { id: bkash, name: "bKash", flow: "hosted" },
          { id: nagad, name: "Nagad", flow: "hosted" },
        ] }) },
        "/api/v1/orders/receipt/old_order": { status: 200, body: envelope({ order: {
          id: "old_order", orderNumber: 100501, customerName: "Buyer", customerPhone: "+8801712345678", customerEmail: null,
          shippingAddress: null, city: null, zone: null, area: null,
          totalAmount: 500, shippingCharge: 0, discountAmount: null, paymentMethod: bkash, paymentStatus: "unpaid",
          status: "incomplete", paidAmount: 0, balanceDue: 500, accountLinked: false,
          createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
          items: [], supportRequests: [], supportRequestActions: [], supportRequestIntro: "Contact the store for help.",
        } }) },
      }),
    );
    expect(response.status).toBe(200);
    const doc = new Window().document;
    doc.write(html);
    expect(doc.querySelector("h1")?.textContent).toBe("Payment didn't go through");
    // Nothing says it is still checking a payment that is known to have failed.
    expect(doc.querySelector("[data-payment-status-message]")).toBeNull();
    expect(doc.title).not.toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.orderReceiptPaymentPendingTitleText);
    const section = doc.querySelector("[data-order-success-state]")!;
    expect(section.getAttribute("data-order-success-state")).toBe("payment_issue");
    // The status check compares with what the store records, so it doesn't reload at once.
    expect(section.getAttribute("data-order-recorded-state")).toBe("payment_pending");
    const buttons = [...doc.querySelectorAll("[data-payment-retry-button]")];
    expect(buttons.map((button) => button.getAttribute("data-gateway"))).toEqual([bkash, nagad]);
    expect(buttons[0]!.textContent).toContain("Try again with bKash");
    expect(doc.querySelector("[data-retry-other-methods]")?.textContent?.trim()).toBe("Or choose another method");
    // No bearer proof in the page.
    expect(html).not.toContain("chk_private_proof");
  });
});
