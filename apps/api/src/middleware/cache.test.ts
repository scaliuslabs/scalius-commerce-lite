import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
  getCacheType: vi.fn(() => "kv"),
}));

vi.mock("../utils/kv-cache", () => ({
  getCache: mocks.getCache,
  setCache: mocks.setCache,
  getCacheType: mocks.getCacheType,
}));

import { cacheMiddleware, canonicalizeCacheQueryString } from "./cache";

describe("cacheMiddleware", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bypasses cache reads and writes when ttl is zero or negative", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", cacheMiddleware({ ttl: 0, keyPrefix: "test:" }));
    app.get("/analytics", (c) => c.json({ value: Date.now() }));

    const response = await app.request("/analytics", {}, {
      CACHE: { id: "api-cache-kv" },
    } as unknown as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cache")).toBeNull();
    expect(mocks.getCache).not.toHaveBeenCalled();
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it("schedules cache writes after the response when executionCtx is available", async () => {
    mocks.getCache.mockResolvedValue(null);

    let resolveWrite: (() => void) | undefined;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    mocks.setCache.mockReturnValue(writePromise);

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", cacheMiddleware({ ttl: 60, keyPrefix: "test:" }));
    app.get("/products", (c) => c.json({ products: [] }));

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };

    const response = await Promise.race([
      app.request(
        "/products",
        {},
        { CACHE: { id: "api-cache-kv" } } as unknown as Env,
        executionCtx as never,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cache write blocked response")), 50),
      ),
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cache")).toBe("MISS");
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(executionCtx.waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);

    resolveWrite?.();
    await executionCtx.waitUntil.mock.calls[0]?.[0];
  });

  it("canonicalizes query order before reading and writing cache keys", async () => {
    mocks.getCache.mockResolvedValue(null);

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", cacheMiddleware({ ttl: 60, keyPrefix: "api:products:" }));
    app.get("/products", (c) => c.json({ products: [] }));

    await app.request("/products?brand=Nike&color=Red", {}, {
      CACHE: { id: "api-cache-kv" },
    } as unknown as Env);
    await app.request("/products?color=Red&brand=Nike", {}, {
      CACHE: { id: "api-cache-kv" },
    } as unknown as Env);

    expect(mocks.getCache).toHaveBeenNthCalledWith(
      1,
      "api:products:/products?brand=Nike&color=Red",
      { id: "api-cache-kv" },
    );
    expect(mocks.getCache).toHaveBeenNthCalledWith(
      2,
      "api:products:/products?brand=Nike&color=Red",
      { id: "api-cache-kv" },
    );
  });

  it("elides configured query defaults without dropping dynamic filters", async () => {
    mocks.getCache.mockResolvedValue(null);

    const app = new Hono<{ Bindings: Env }>();
    app.use(
      "*",
      cacheMiddleware({
        ttl: 60,
        keyPrefix: "api:products:",
        queryDefaults: { page: 1, limit: 20, sort: "newest" },
      }),
    );
    app.get("/products", (c) => c.json({ products: [] }));

    await app.request(
      "/products?page=1&limit=20&sort=newest&brand=Nike&color=Red",
      {},
      { CACHE: { id: "api-cache-kv" } } as unknown as Env,
    );

    expect(mocks.getCache).toHaveBeenCalledWith(
      "api:products:/products?brand=Nike&color=Red",
      { id: "api-cache-kv" },
    );
  });

  it("supports path-aware query defaults", async () => {
    mocks.getCache.mockResolvedValue(null);

    const app = new Hono<{ Bindings: Env }>();
    app.use(
      "*",
      cacheMiddleware({
        ttl: 60,
        keyPrefix: "api:products:",
        queryDefaults: (c) =>
          c.req.path.endsWith("/search")
            ? { search: "", page: 1, limit: 10 }
            : { page: 1, limit: 20, sort: "newest" },
      }),
    );
    app.get("/products", (c) => c.json({ products: [] }));
    app.get("/products/search", (c) => c.json({ products: [] }));

    await app.request("/products?limit=20&page=1&sort=newest", {}, {
      CACHE: { id: "api-cache-kv" },
    } as unknown as Env);
    await app.request("/products/search?limit=20&page=1&search=", {}, {
      CACHE: { id: "api-cache-kv" },
    } as unknown as Env);

    expect(mocks.getCache).toHaveBeenNthCalledWith(
      1,
      "api:products:/products",
      { id: "api-cache-kv" },
    );
    expect(mocks.getCache).toHaveBeenNthCalledWith(
      2,
      "api:products:/products/search?limit=20",
      { id: "api-cache-kv" },
    );
  });

  it("canonicalizes duplicate query values deterministically", () => {
    expect(
      canonicalizeCacheQueryString(
        "https://api.example.test/products?tag=b&tag=a&page=1",
        { page: 1 },
      ),
    ).toBe("tag=a&tag=b");
  });
});
