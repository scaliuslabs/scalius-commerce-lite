// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STOREFRONT_BATCH_PATH,
  parseStorefrontBatchParts,
} from "@scalius/shared/public-api-cache-routes";

import { requestRuntime, type StorefrontRuntime } from "./runtime";
import { apiFetch } from "./transport";
import { getLayoutData, getHomepageData } from "./storefront";
import { getAllProducts, getProductBySlugResult, getProductsByCategory } from "./products";
import { getCities, getShippingMethods } from "./shipping";
import { getActiveCheckoutLanguage } from "./settings";
import { getCheckoutConfig } from "./checkout";
import { hashCacheDep } from "@scalius/shared/cache-frontier";
import { loadPageWithLayout } from "@/lib/page-data";
import { createPageDependencies, pageEntryFromDependencies, recordPagePart, type PageDependencies } from "@/lib/page-dependencies";

/**
 * Per-page API budget: a storefront page render is ONE service binding call.
 * Each page's reads (the same functions the page calls, started together as
 * the page starts them) must reach the API as a single storefront batch.
 */
const PAGE_API_CALL_BUDGET = 1;

const apiBaseUrl = "https://api.example.test/api/v1";

function envelope(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

/** Minimal bodies for each public read a page makes. */
function bodyFor(path: string): { status: number; body: string } {
  if (path === "/api/v1/storefront/layout") {
    return { status: 200, body: envelope({ header: {}, footer: {}, navigation: [], analytics: [], platform: { apiUrl: "https://api.example.test" } }) };
  }
  if (path === "/api/v1/storefront/homepage") {
    return { status: 200, body: envelope({ seo: {}, hero: {}, collections: [], presentation: { trustStrip: { enabled: true } } }) };
  }
  if (path.startsWith("/api/v1/products/missing")) return { status: 404, body: JSON.stringify({ success: false }) };
  if (path.startsWith("/api/v1/products/")) {
    return { status: 200, body: envelope({ product: { id: "p1", slug: "linen" }, variants: [], media: [], recommendations: { reason: "popular", products: [] } }) };
  }
  if (path.startsWith("/api/v1/categories/")) {
    return { status: 200, body: envelope({ category: { id: "c1", slug: "bags" }, products: [], pagination: { page: 1, total: 0, totalPages: 0 } }) };
  }
  if (path.startsWith("/api/v1/products")) {
    return { status: 200, body: envelope({ products: [], pagination: { page: 1, total: 0, totalPages: 0 } }) };
  }
  if (path === "/api/v1/shipping-methods") return { status: 200, body: envelope({ shippingMethods: [{ id: "s1" }] }) };
  if (path === "/api/v1/checkout/config") return { status: 200, body: envelope({ gateways: [{ id: "cod" }] }) };
  if (path === "/api/v1/locations/cities") return { status: 200, body: envelope([{ id: "dhaka", name: "Dhaka" }]) };
  if (path === "/api/v1/checkout-languages/active") {
    return { status: 200, body: envelope({ language: { id: "lang_bn", code: "bn", languageData: {} } }) };
  }
  return { status: 404, body: "{}" };
}

interface Backend {
  fetcher: Fetcher;
  calls: string[];
}

function backend(options: { batchStatus?: number; proof?: boolean } = {}): Backend {
  const calls: string[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === STOREFRONT_BATCH_PATH) {
      if (options.batchStatus) return new Response("{}", { status: options.batchStatus });
      const parts = parseStorefrontBatchParts(url) ?? [];
      return Response.json({
        success: true,
        data: {
          parts: parts.map((part) => ({
            ...bodyFor(part.pathname),
            contentType: "application/json",
            ...(options.proof
              ? { cache: { apiVersion: "api-a", status: "miss", s0: part.pathname.length, deps: [hashCacheDep(part.pathname)], validUntil: null, softMaxAgeSeconds: null, renderedAt: 1 } }
              : {}),
          })),
        },
      });
    }
    const { status, body } = bodyFor(url.pathname);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher: { fetch } as unknown as Fetcher, calls };
}

function render<T>(api: Backend, task: () => Promise<T>, pageDependencies?: PageDependencies): Promise<T> {
  const runtime: StorefrontRuntime = {
    PUBLIC_API_URL: apiBaseUrl,
    BACKEND_API: api.fetcher,
    inflightReads: new Map(),
    pageDependencies,
  };
  return requestRuntime.run(runtime, task);
}

beforeEach(() => {
  vi.stubEnv("SSR", true);
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("page render API budget", () => {
  it("renders a product page from one API call", async () => {
    const api = backend();
    const [layout, product, shipping, config] = await render(api, () => Promise.all([
      getLayoutData(),
      getProductBySlugResult("linen"),
      getShippingMethods(),
      getCheckoutConfig(),
    ]));

    expect(api.calls).toHaveLength(PAGE_API_CALL_BUDGET);
    expect(api.calls[0]).toContain(STOREFRONT_BATCH_PATH);
    expect(layout?.platform?.apiUrl).toBe("https://api.example.test");
    expect(product.state).toBe("found");
    expect(shipping).toEqual([{ id: "s1" }]);
    expect(config.gateways).toEqual([{ id: "cod" }]);
  });

  it("renders the home page, with its delivery facts, from one API call", async () => {
    const api = backend();
    await render(api, async () => {
      const shipping = getShippingMethods();
      const config = getCheckoutConfig();
      const { layoutData, pageData } = await loadPageWithLayout(() => getHomepageData());
      expect(layoutData).not.toBeNull();
      expect(pageData?.presentation.trustStrip.enabled).toBe(true);
      await Promise.all([shipping, config]);
    });

    expect(api.calls).toHaveLength(PAGE_API_CALL_BUDGET);
  });

  it("renders category and search pages from one API call each", async () => {
    const category = backend();
    await render(category, () => Promise.all([getLayoutData(), getProductsByCategory("bags", { page: 1 })]));
    const search = backend();
    await render(search, () => Promise.all([getLayoutData(), getAllProducts({ search: "linen", page: 1 })]));

    expect(category.calls).toHaveLength(PAGE_API_CALL_BUDGET);
    expect(search.calls).toHaveLength(PAGE_API_CALL_BUDGET);
  });

  it("renders the cart shell, with its checkout copy, from one API call", async () => {
    const api = backend();
    const [layout, cities, shipping, language, config] = await render(api, () => Promise.all([
      getLayoutData(),
      getCities(),
      getShippingMethods(),
      getActiveCheckoutLanguage(),
      getCheckoutConfig(),
    ]));

    expect(api.calls).toHaveLength(PAGE_API_CALL_BUDGET);
    expect(api.calls[0]).toContain(STOREFRONT_BATCH_PATH);
    expect(layout).not.toBeNull();
    expect(cities).toEqual([{ id: "dhaka", name: "Dhaka" }]);
    expect(shipping).toEqual([{ id: "s1" }]);
    expect(language?.code).toBe("bn");
    expect(config.gateways).toEqual([{ id: "cod" }]);
  });

  it("keeps each part's own status", async () => {
    const api = backend();
    const [, product] = await render(api, () => Promise.all([
      getLayoutData(),
      getProductBySlugResult("missing"),
    ]));

    expect(api.calls).toHaveLength(1);
    expect(product.state).toBe("not_found");
  });
});

describe("render read batch transport", () => {
  it("sends a lone read as itself", async () => {
    const api = backend();
    await render(api, () => getShippingMethods());

    expect(api.calls).toEqual(["/api/v1/shipping-methods"]);
  });

  it("falls back to one read each when the API has no batch route", async () => {
    const api = backend({ batchStatus: 404 });
    const [layout, shipping] = await render(api, () => Promise.all([getLayoutData(), getShippingMethods()]));

    expect(api.calls[0]).toContain(STOREFRONT_BATCH_PATH);
    expect(api.calls.slice(1).sort()).toEqual(["/api/v1/shipping-methods", "/api/v1/storefront/layout"]);
    expect(layout).not.toBeNull();
    expect(shipping).toEqual([{ id: "s1" }]);
  });

  it("never batches authenticated, private or write calls", async () => {
    const api = backend();
    await render(api, () => Promise.all([
      apiFetch(`${apiBaseUrl}/orders/status/cst_x`, {}, { auth: false }),
      apiFetch(`${apiBaseUrl}/search?q=linen`, {}, { auth: false }),
      apiFetch(`${apiBaseUrl}/products`, { method: "POST", body: "{}" }, { auth: false }),
      apiFetch(`${apiBaseUrl}/products`, { headers: { "X-Customer-Session": "s" } }, { auth: false }),
    ]));

    expect(api.calls.some((call) => call.includes(STOREFRONT_BATCH_PATH))).toBe(false);
    expect(api.calls).toHaveLength(4);
  });
});

describe("page dependency proof", () => {
  it("rejects mixed or absent API deployment proofs", () => {
    const proof = { apiVersion: "api-a", status: "hit" as const, s0: 1, deps: [], validUntil: null, softMaxAgeSeconds: null, renderedAt: 0 };
    const dependencies = createPageDependencies();
    recordPagePart(dependencies, proof);
    expect(pageEntryFromDependencies(dependencies)?.apiVersion).toBe("api-a");
    recordPagePart(dependencies, { ...proof, apiVersion: "api-b" });
    expect(pageEntryFromDependencies(dependencies)).toBeNull();
    const absent = createPageDependencies();
    recordPagePart(absent, { ...proof, apiVersion: "" });
    expect(pageEntryFromDependencies(absent)).toBeNull();
  });
  it("composes every batch part's proof, and sends a lone read as a batch of one", async () => {
    const api = backend({ proof: true });
    const dependencies = createPageDependencies();
    await render(api, () => Promise.all([getLayoutData(), getShippingMethods()]), dependencies);
    await render(api, () => getCities(), dependencies);

    expect(api.calls.every((call) => call.startsWith(STOREFRONT_BATCH_PATH))).toBe(true);
    const entry = pageEntryFromDependencies(dependencies);
    expect(entry?.s0).toBe(Math.min(..."/api/v1/storefront/layout /api/v1/shipping-methods /api/v1/locations/cities".split(" ").map((path) => path.length)));
    expect(entry?.depHashes).toHaveLength(3);
  });

  it("starts the next batch instead of a lone read when a batch is full", async () => {
    const api = backend({ proof: true });
    const dependencies = createPageDependencies();
    await render(api, () => Promise.all(Array.from({ length: 10 }, (_, index) => getProductBySlugResult(`p${index}`))), dependencies);

    expect(api.calls).toHaveLength(2);
    expect(pageEntryFromDependencies(dependencies)).not.toBeNull();
  });

  it("proves nothing when a part carries no proof or a read left the batch", async () => {
    const unproven = createPageDependencies();
    await render(backend(), () => Promise.all([getLayoutData(), getShippingMethods()]), unproven);
    expect(pageEntryFromDependencies(unproven)).toBeNull();

    const outside = createPageDependencies();
    await render(backend({ proof: true }), () => Promise.all([
      getLayoutData(),
      apiFetch(`${apiBaseUrl}/search?q=linen`, {}, { auth: false }),
    ]), outside);
    expect(pageEntryFromDependencies(outside)).toBeNull();
  });
});
