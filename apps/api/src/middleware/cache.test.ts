import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
  getCacheType: vi.fn(() => "kv"),
}));

vi.mock("../utils/kv-cache", () => ({
  deleteCache: vi.fn(),
  getCache: mocks.getCache,
  setCache: mocks.setCache,
  getCacheType: mocks.getCacheType,
  toProjectCacheKey: (key: string) => `sc:${key}`,
}));

import { cacheMiddleware, canonicalizeCacheQueryString } from "./cache";

function withoutFenceToken(cacheKey: string): string {
  return cacheKey.replace(/#f:[0-9a-f]+$/, "");
}

function createFenceKvStore() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    list: vi.fn(),
    delete: vi.fn(),
  };
  return { kv, store };
}

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

  it("uses fenced cache keys for reads and writes", async () => {
    mocks.getCache.mockResolvedValue(null);

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", cacheMiddleware({ ttl: 60, keyPrefix: "api:products:" }));
    app.get("/products", (c) => c.json({ products: [] }));

    const response = await app.request("/products", {}, {
      CACHE: { id: "api-cache-kv" },
    } as unknown as Env);

    expect(response.status).toBe(200);
    const readKey = mocks.getCache.mock.calls[0]?.[0] as string;
    const writeKey = mocks.setCache.mock.calls[0]?.[0] as string;
    expect(withoutFenceToken(readKey)).toBe("api:products:/products");
    expect(withoutFenceToken(writeKey)).toBe("api:products:/products");
    expect(readKey).toMatch(/^api:products:\/products#f:[0-9a-f]+$/);
    expect(writeKey).toBe(readKey);
  });

  it("skips a delayed miss write when the captured fence changes", async () => {
    mocks.getCache.mockResolvedValue(null);
    mocks.setCache.mockResolvedValue(undefined);

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", cacheMiddleware({ ttl: 60, keyPrefix: "api:products:" }));
    app.get("/products", (c) => c.json({ products: [] }));

    const { kv, store } = createFenceKvStore();
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    };

    const response = await app.request(
      "/products",
      {},
      { CACHE: kv } as unknown as Env,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);

    store.set(
      "sc:_api_cache_fence:api%3Aproducts%3A",
      JSON.stringify({
        schema: 1,
        scope: "api:products:",
        version: "newer-version",
        updatedAt: Date.now(),
      }),
    );

    await executionCtx.waitUntil.mock.calls[0]?.[0];
    expect(mocks.setCache).not.toHaveBeenCalled();
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

    expect(withoutFenceToken(mocks.getCache.mock.calls[0]?.[0] as string)).toBe(
      "api:products:/products?brand=Nike&color=Red",
    );
    expect(withoutFenceToken(mocks.getCache.mock.calls[1]?.[0] as string)).toBe(
      "api:products:/products?brand=Nike&color=Red",
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

    expect(withoutFenceToken(mocks.getCache.mock.calls[0]?.[0] as string)).toBe(
      "api:products:/products?brand=Nike&color=Red",
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

    expect(withoutFenceToken(mocks.getCache.mock.calls[0]?.[0] as string)).toBe(
      "api:products:/products",
    );
    expect(withoutFenceToken(mocks.getCache.mock.calls[1]?.[0] as string)).toBe(
      "api:products:/products/search?limit=20",
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
