import { describe, expect, it, vi } from "vitest";
import { storefrontBatchPath } from "@scalius/shared/public-api-cache-routes";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { serveStorefrontBatch, type StorefrontBatchDeps } from "./storefront-batch";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

const batchUrl = (parts: string[]) => `https://api.internal${storefrontBatchPath(parts)}`;

function deps(overrides: Partial<StorefrontBatchDeps> = {}): StorefrontBatchDeps {
  return {
    readGeneration: async () => "gen1",
    fetchPart: async (part) => Response.json({ success: true, data: new URL(part.url).pathname }),
    ...overrides,
  };
}

async function parts(response: Response) {
  const body = await response.json() as { data: { parts: Array<{ status: number; body: string }> } };
  return body.data.parts.map((part) => ({ status: part.status, body: JSON.parse(part.body) }));
}

describe("storefront read batch", () => {
  it("answers every part in order, each exactly as its own read, pinned to one generation", async () => {
    const fetchPart = vi.fn<StorefrontBatchDeps["fetchPart"]>(async (part) => {
      const path = new URL(part.url).pathname;
      if (path.endsWith("/missing")) return Response.json({ success: false }, { status: 404 });
      return Response.json({ success: true, data: path });
    });

    const response = await serveStorefrontBatch(
      new Request(batchUrl(["/api/v1/storefront/layout", "/api/v1/products/missing", "/api/v1/shipping-methods"])),
      deps({ fetchPart }),
    );

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await parts(response)).toEqual([
      { status: 200, body: { success: true, data: "/api/v1/storefront/layout" } },
      { status: 404, body: { success: false } },
      { status: 200, body: { success: true, data: "/api/v1/shipping-methods" } },
    ]);
    expect(fetchPart.mock.calls.map(([, generation]) => generation)).toEqual(["gen1", "gen1", "gen1"]);
    for (const [part] of fetchPart.mock.calls) {
      expect(part.method).toBe("GET");
      expect(part.headers.has("Cookie")).toBe(false);
      expect(part.headers.has("Authorization")).toBe(false);
    }
  });

  it("keeps the other parts when one fails", async () => {
    const response = await serveStorefrontBatch(
      new Request(batchUrl(["/api/v1/storefront/layout", "/api/v1/checkout/config"])),
      deps({
        fetchPart: async (part) => {
          if (part.url.includes("checkout")) throw new Error("boom");
          return Response.json({ success: true });
        },
      }),
    );

    expect((await parts(response)).map((part) => part.status)).toEqual([200, 502]);
  });

  it("refuses credentials, writes and anything but public cached reads", async () => {
    const fetchPart = vi.fn<StorefrontBatchDeps["fetchPart"]>();
    const layout = batchUrl(["/api/v1/storefront/layout"]);

    expect((await serveStorefrontBatch(new Request(layout, { headers: { Cookie: "a=b" } }), deps({ fetchPart }))).status).toBe(400);
    expect((await serveStorefrontBatch(new Request(layout, { headers: { Authorization: "Bearer x" } }), deps({ fetchPart }))).status).toBe(400);
    expect((await serveStorefrontBatch(new Request(layout, { method: "POST" }), deps({ fetchPart }))).status).toBe(405);
    expect((await serveStorefrontBatch(new Request(batchUrl(["/api/v1/orders/receipt/order_1"])), deps({ fetchPart }))).status).toBe(400);
    expect(fetchPart).not.toHaveBeenCalled();
  });
});

describe("storefront batch route", () => {
  const env = () => {
    const { binding } = createSqliteD1Database();
    return {
      DB: binding,
      CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
      JWT_SECRET: "storefront-batch-secret-0123456789abcdef",
    } as unknown as Env;
  };

  it("serves each part through the public cache entrypoint, keyed by the page's generation", async () => {
    const cached: string[] = [];
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      exports: {
        PublicApi: {
          fetch: async (request: Request) => {
            cached.push(request.url);
            return Response.json({ success: true, data: new URL(request.url).pathname });
          },
        },
      },
    } as unknown as ExecutionContext;

    const response = await fetchRuntimeApiApp(
      new Request(batchUrl(["/api/v1/storefront/layout", "/api/v1/products?search=linen&page=1"]), {
        headers: { "X-Scalius-Cache-Generation": "abc123" },
      }),
      env(),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await parts(response)).map((part) => part.body.data)).toEqual(["/api/v1/storefront/layout", "/api/v1/products"]);
    expect(cached).toEqual([
      "https://api.internal/api/v1/storefront/layout?__cg=abc123",
      "https://api.internal/api/v1/products?page=1&search=linen&__cg=abc123",
    ]);
  });

  describe("when the cache entrypoint answers", () => {
    const batchWithCache = async (cacheResponse: () => Response) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const ctx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        exports: { PublicApi: { fetch: async () => cacheResponse() } },
      } as unknown as ExecutionContext;
      try {
        const response = await fetchRuntimeApiApp(
          new Request(batchUrl(["/api/v1/shipping-methods?zone=secret-zone"]), {
            headers: { "X-Scalius-Cache-Generation": "abc123" },
          }),
          env(),
          ctx,
        );
        return { part: (await parts(response))[0]!, warnings: warn.mock.calls.map((call) => String(call[0])) };
      } finally {
        warn.mockRestore();
      }
    };

    it("a platform 500 without our headers, it renders the part directly and logs one masked line", async () => {
      const { part, warnings } = await batchWithCache(() => new Response(null, { status: 500 }));

      expect(part).toMatchObject({ status: 200, body: { success: true, data: { shippingMethods: [] } } });
      expect(warnings).toEqual(["[PublicCache] cache layer answered 500 for /api/v1/shipping-methods; rendering it directly"]);
    });

    it("our own 5xx, it passes it through without a second render", async () => {
      const { part, warnings } = await batchWithCache(() => Response.json(
        { success: false, error: "ours" },
        { status: 503, headers: { "X-Content-Type-Options": "nosniff" } },
      ));

      expect(part).toEqual({ status: 503, body: { success: false, error: "ours" } });
      expect(warnings).toEqual([]);
    });

    it("a 200, it leaves it untouched", async () => {
      const { part } = await batchWithCache(() => Response.json({ success: true, data: "cached" }));

      expect(part).toEqual({ status: 200, body: { success: true, data: "cached" } });
    });
  });

  it("renders parts directly without a cache entrypoint, keeping each part's status", async () => {
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

    const response = await fetchRuntimeApiApp(
      new Request(batchUrl(["/api/v1/shipping-methods", "/api/v1/products/missing-product"])),
      env(),
      ctx,
    );

    expect((await parts(response)).map((part) => part.status)).toEqual([200, 404]);
  });
});
