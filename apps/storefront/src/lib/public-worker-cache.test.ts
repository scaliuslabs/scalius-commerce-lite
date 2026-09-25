// @vitest-environment node
// happy-dom drops Set-Cookie from constructed Responses (a forbidden response
// header in browsers), which would hide the "never cache cookies" guard.
import { describe, expect, it, vi } from "vitest";

import {
  applyPublicStorefrontPreconnectHint,
  getPublicStorefrontCachePolicy,
  isLayoutBatchedPagePath,
  publicStorefrontCacheKey,
  servePublicStorefrontRequest,
  type PublicStorefrontCacheContext,
} from "./public-worker-cache";

const GENERATION_HEADER = "X-Scalius-Cache-Generation";

/** Node's Request drops Cookie on construction, so model the Worker request. */
function workerRequest(path: string, headers: Record<string, string> = {}): Request {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method: "GET",
    url: `https://shop.example${path}`,
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
      has: (name: string) => normalized.has(name.toLowerCase()),
    },
  } as unknown as Request;
}

function renderedPage(body = "<html>page</html>", headers: Record<string, string> = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Cache-Status": "MISS",
      ...headers,
    },
  });
}

function createContext(overrides: Partial<PublicStorefrontCacheContext> = {}) {
  const store = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const render = vi.fn(async (_request: Request) => renderedPage());
  const context: PublicStorefrontCacheContext = {
    cache: {
      match: vi.fn(async (key: RequestInfo | URL) => store.get(String(key))?.clone()),
      put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
        store.set(String(key), response);
      }),
    } as unknown as PublicStorefrontCacheContext["cache"],
    readGeneration: vi.fn(async () => "gen1"),
    buildId: "build-a",
    workerVersion: "ver-1",
    render,
    waitUntil: (promise) => pending.push(promise),
    ...overrides,
  };
  return { context, store, render, settle: () => Promise.all(pending) };
}

describe("public storefront cache policy", () => {
  it("adds only a stable HTTPS CDN preconnect candidate", () => {
    const response = new Response("page", {
      headers: { Link: "</_astro/app.js>; rel=preload; as=script" },
    });

    applyPublicStorefrontPreconnectHint(response, "cloud.example.com/media");
    applyPublicStorefrontPreconnectHint(response, "https://cloud.example.com");

    expect(response.headers.get("Link")).toBe(
      "</_astro/app.js>; rel=preload; as=script, <https://cloud.example.com>; rel=preconnect; crossorigin",
    );
  });

  it.each([
    "http://cloud.example.com",
    "https://user:secret@cloud.example.com",
    "not a host",
    "",
  ])("rejects unsafe Early Hints origin %j", (configuredCdnUrl) => {
    const response = new Response("page");
    applyPublicStorefrontPreconnectHint(response, configuredCdnUrl);
    expect(response.headers.get("Link")).toBeNull();
  });

  it("maps equivalent query forms and tracking parameters to one canonical URL", () => {
    const left = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about/?ref=footer&campaign=sale"),
    );
    const right = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about?campaign=sale&ref=footer"),
    );
    expect(left).toEqual({ canonicalUrl: "https://shop.example/about?campaign=sale" });
    expect(right).toEqual(left);
  });

  it.each([
    "/",
    "/products/fish",
    "/categories/fish",
    "/collections/featured",
    "/search?q=fish",
    "/blog/news",
    "/blog/feed.xml",
    "/robots.txt",
    "/sitemap.xml",
    "/sitemap-products.xml",
    "/api/product-feed.xml",
    "/api/facebook-feed.xml",
    "/.well-known/ucp",
    "/llms.txt",
  ])("caches public route %s", (path) => {
    expect(getPublicStorefrontCachePolicy(new Request(`https://shop.example${path}`))).not.toBeNull();
  });

  it.each([
    ["checkout", "/checkout", {}],
    ["checkout step", "/checkout/payment", {}],
    ["signed-in cart", "/cart", { Cookie: "cs_auth=1; cs_tok=private" }],
    ["account", "/account/orders", {}],
    ["receipt", "/order-success", {}],
    ["recovery", "/payment-recovery", {}],
    ["variant selection", "/products/fish?size=large", {}],
    ["signed-in buyer", "/products/fish", { Cookie: "_fbp=fb.1.1; cs_auth=1" }],
    ["session", "/about", { Cookie: "cs_tok=private" }],
    ["theme preview", "/", { Cookie: "stp_theme_preview=tpv" }],
    ["authorization", "/about", { Authorization: "Bearer private" }],
  ])("never caches a %s request", (_label, path, headers) => {
    expect(getPublicStorefrontCachePolicy(workerRequest(path, headers))).toBeNull();
  });

  it("caches the cart shell under one canonical URL whatever the query", () => {
    for (const path of ["/cart", "/cart/", "/cart?quickBuyStorage=blocked", "/cart?checkoutIssues=1&utm_source=x"]) {
      expect(getPublicStorefrontCachePolicy(workerRequest(path, { Cookie: "_fbp=fb.1.1" })), path)
        .toEqual({ canonicalUrl: "https://shop.example/cart" });
    }
    expect(getPublicStorefrontCachePolicy(new Request("https://shop.example/cart", { method: "POST" }))).toBeNull();
    expect(getPublicStorefrontCachePolicy(workerRequest("/cart/extra"))).toBeNull();
  });

  it("keeps tracking-cookie visitors on the shared cache lane", () => {
    const policy = getPublicStorefrontCachePolicy(
      workerRequest("/products/fish", { Cookie: "_fbp=fb.1.1; _fbc=fb.1.2.abc; _ga=GA1.1" }),
    );
    expect(policy?.canonicalUrl).toBe("https://shop.example/products/fish");
  });

  it("keys entries by build, Worker version, generation, and canonical URL", () => {
    expect(publicStorefrontCacheKey("https://shop.example/search?q=fish", "build-a", "ver-1", "gen1"))
      .toBe("https://shop.example/__cache/build-a/ver-1/gen1/search?q=fish");
    expect(publicStorefrontCacheKey("https://shop.example/", "build-a", "ver-1", "gen2"))
      .not.toBe(publicStorefrontCacheKey("https://shop.example/", "build-a", "ver-1", "gen1"));
    expect(publicStorefrontCacheKey("https://shop.example/", "build-b", "ver-1", "gen1"))
      .not.toBe(publicStorefrontCacheKey("https://shop.example/", "build-a", "ver-1", "gen1"));
    // Same build id and generation, new deploy: BUILD_ID hashes only some
    // inputs, the Worker version changes with any of them.
    expect(publicStorefrontCacheKey("https://shop.example/", "build-a", "ver-2", "gen1"))
      .not.toBe(publicStorefrontCacheKey("https://shop.example/", "build-a", "ver-1", "gen1"));
  });
});

describe("servePublicStorefrontRequest", () => {
  it("renders a miss pinned to the generation, stores it, and serves the next visitor from cache", async () => {
    const { context, render, settle } = createContext();

    const first = await servePublicStorefrontRequest(
      new Request("https://shop.example/products/fish?fbclid=ad"),
      context,
    );
    await settle();
    expect(first.headers.get("X-Cache-Status")).toBe("MISS");
    expect(render).toHaveBeenCalledTimes(1);
    const rendered = render.mock.calls[0]![0];
    expect(rendered.url).toBe("https://shop.example/products/fish");
    expect(rendered.headers.get(GENERATION_HEADER)).toBe("gen1");
    expect(context.cache.put).toHaveBeenCalledWith(
      "https://shop.example/__cache/build-a/ver-1/gen1/products/fish",
      expect.any(Response),
    );

    const second = await servePublicStorefrontRequest(
      new Request("https://shop.example/products/fish"),
      context,
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(second.headers.get("X-Cache-Status")).toBe("HIT");
    expect(second.headers.get("Cache-Control")).toBe("no-cache");
    expect(await second.text()).toBe("<html>page</html>");
  });

  it("serves every ad-click and campaign visit from the plain page's entry, without a redirect", async () => {
    const { context, render, settle } = createContext();
    await servePublicStorefrontRequest(new Request("https://shop.example/products/fish"), context);
    await settle();
    expect(render).toHaveBeenCalledTimes(1);

    const longClickId = "x".repeat(700);
    for (const query of [
      `?fbclid=${longClickId}`,
      "?gclid=g&gad_source=1&gad_campaignid=22&srsltid=AfmBOo",
      "?utm_source=fb&utm_medium=paid&utm_campaign=eid&utm_id=9&utm_content=a&utm_term=b",
      "?yclid=1&msclkid=2&ttclid=3&mc_cid=4&mc_eid=5&igshid=6&_ga=2.1.3&wbraid=7&gbraid=8",
    ]) {
      const response = await servePublicStorefrontRequest(
        new Request(`https://shop.example/products/fish${query}`),
        context,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Cache-Status")).toBe("HIT");
    }
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("keeps functional parameters in the key", async () => {
    const { context, render, settle } = createContext();
    await servePublicStorefrontRequest(new Request("https://shop.example/categories/drinks?page=2&utm_source=fb"), context);
    await settle();
    await servePublicStorefrontRequest(new Request("https://shop.example/categories/drinks"), context);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0]![0].url).toBe("https://shop.example/categories/drinks?page=2");
  });

  it("stores the edge copy with a bounded lifetime and restores browser headers on a hit", async () => {
    const { context, store, settle } = createContext();
    await servePublicStorefrontRequest(new Request("https://shop.example/sitemap.xml"), context);
    await settle();

    const stored = [...store.values()][0]!;
    expect(stored.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(stored.headers.has("Expires")).toBe(false);

    const hit = await servePublicStorefrontRequest(new Request("https://shop.example/sitemap.xml"), context);
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=0, no-cache, must-revalidate");
  });

  it("misses after the generation changes, so a write needs no purge", async () => {
    let generation = "gen1";
    const { context, render, settle } = createContext({
      readGeneration: async () => generation,
    });
    await servePublicStorefrontRequest(new Request("https://shop.example/"), context);
    await settle();
    generation = "gen2";
    const afterWrite = await servePublicStorefrontRequest(new Request("https://shop.example/"), context);

    expect(afterWrite.headers.get("X-Cache-Status")).toBe("MISS");
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1]![0].headers.get(GENERATION_HEADER)).toBe("gen2");
  });

  it("misses after a deploy under the same build id and generation", async () => {
    const { context, render, settle } = createContext();
    await servePublicStorefrontRequest(new Request("https://shop.example/"), context);
    await settle();
    const afterDeploy = await servePublicStorefrontRequest(
      new Request("https://shop.example/"),
      { ...context, workerVersion: "ver-2" },
    );

    expect(afterDeploy.headers.get("X-Cache-Status")).toBe("MISS");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("renders uncached without a Worker version", async () => {
    const { context, render } = createContext({ workerVersion: null });

    await servePublicStorefrontRequest(
      new Request("https://shop.example/", { headers: { [GENERATION_HEADER]: "forged" } }),
      context,
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0].headers.has(GENERATION_HEADER)).toBe(false);
    expect(context.readGeneration).not.toHaveBeenCalled();
    expect(context.cache.match).not.toHaveBeenCalled();
    expect(context.cache.put).not.toHaveBeenCalled();
  });

  it("renders private requests directly without reading the generation or touching the cache", async () => {
    const { context, render } = createContext();
    const request = workerRequest("/checkout");

    await servePublicStorefrontRequest(request, context);

    expect(render).toHaveBeenCalledWith(request);
    expect(context.readGeneration).not.toHaveBeenCalled();
    expect(context.cache.match).not.toHaveBeenCalled();
    expect(context.cache.put).not.toHaveBeenCalled();
  });

  it("strips a caller-supplied generation from uncached renders", async () => {
    const { context, render } = createContext({ readGeneration: async () => null });

    await servePublicStorefrontRequest(
      new Request("https://shop.example/", { headers: { [GENERATION_HEADER]: "forged" } }),
      context,
    );

    expect(render.mock.calls[0]![0].headers.has(GENERATION_HEADER)).toBe(false);
    expect(context.cache.put).not.toHaveBeenCalled();
  });

  it.each([
    ["an error page", new Response("oops", { status: 500, headers: { "X-Cache-Status": "MISS" } })],
    ["a response that sets a cookie", renderedPage("x", { "Set-Cookie": "cs_auth=1" })],
    ["a response that failed the public gate", renderedPage("x", { "X-Cache-Status": "BYPASS" })],
  ])("never stores %s", async (_label, response) => {
    const { context } = createContext({ render: async () => response });
    await servePublicStorefrontRequest(new Request("https://shop.example/"), context);
    expect(context.cache.put).not.toHaveBeenCalled();
  });
});

describe("the cart shell", () => {
  const shell = () => renderedPage("<html>cart shell</html>", {
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
  });

  it("stores one buyer-agnostic entry and keeps the browser copy no-store", async () => {
    const render = vi.fn(async (_request: Request) => shell());
    const { context, store, settle } = createContext({ render });
    const buyer = workerRequest("/cart?quickBuyStorage=blocked", {
      Cookie: "_fbp=fb.1.1; order_receipt=proof; scalius_checkout=chk_x",
      Accept: "text/html",
    });

    const first = await servePublicStorefrontRequest(buyer, context);
    await settle();

    // The render never sees the buyer's cookies or query.
    const rendered = render.mock.calls[0]![0] as Request;
    expect(rendered.url).toBe("https://shop.example/cart");
    expect(rendered.headers.has("Cookie")).toBe(false);
    expect(rendered.headers.get(GENERATION_HEADER)).toBe("gen1");
    expect(first.headers.get("X-Cache-Status")).toBe("MISS");
    expect([...store.keys()]).toEqual(["https://shop.example/__cache/build-a/ver-1/gen1/cart"]);

    const hit = await servePublicStorefrontRequest(workerRequest("/cart"), context);
    expect(render).toHaveBeenCalledTimes(1);
    expect(hit.headers.get("X-Cache-Status")).toBe("HIT");
    expect(hit.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
    expect(hit.headers.has("Set-Cookie")).toBe(false);
    expect(await hit.text()).toBe("<html>cart shell</html>");
  });

  it("renders a signed-in buyer's cart and a POST live, and never stores them", async () => {
    const render = vi.fn(async (_request: Request) => shell());
    const { context } = createContext({ render });

    await servePublicStorefrontRequest(workerRequest("/cart", { Cookie: "cs_tok=secret" }), context);
    await servePublicStorefrontRequest(
      new Request("https://shop.example/cart", { method: "POST", body: "formIntent=checkout" }),
      context,
    );

    expect(render).toHaveBeenCalledTimes(2);
    expect(context.readGeneration).not.toHaveBeenCalled();
    expect(context.cache.put).not.toHaveBeenCalled();
  });

  it.each([
    ["a cart that sets a cookie", { "Set-Cookie": "cs_auth=; Max-Age=0" }],
    ["a cart rendered from a failed read", { "X-Cache-Status": "BYPASS_DEGRADED" }],
  ])("never stores %s", async (_label, headers) => {
    const { context } = createContext({ render: async () => renderedPage("x", headers) });
    await servePublicStorefrontRequest(workerRequest("/cart"), context);
    expect(context.cache.put).not.toHaveBeenCalled();
  });

  it.each(["/checkout", "/order-success?orderId=o1", "/payment-recovery", "/account", "/track-order"])(
    "still renders %s for every request",
    async (path) => {
      const { context, render } = createContext();
      await servePublicStorefrontRequest(workerRequest(path), context);
      expect(render).toHaveBeenCalledTimes(1);
      expect(context.cache.match).not.toHaveBeenCalled();
      expect(context.cache.put).not.toHaveBeenCalled();
    },
  );
});

describe("pages that batch their layout read", () => {
  it("covers the storefront pages and none of the discovery or proxy routes", () => {
    for (const path of ["/", "/products/linen", "/categories/bags/", "/collections/c1", "/search", "/cart", "/checkout", "/blog", "/blog/post", "/about-us", "/categories", "/navigation/panels"]) {
      expect(isLayoutBatchedPagePath(path), path).toBe(true);
    }
    for (const path of ["/sitemap.xml", "/robots.txt", "/blog/feed.xml", "/api/product-feed.xml", "/api/cart/validate", "/account", "/order-success", "/llms.txt", "/.well-known/ucp", "/theme-preview"]) {
      expect(isLayoutBatchedPagePath(path), path).toBe(false);
    }
  });
});
