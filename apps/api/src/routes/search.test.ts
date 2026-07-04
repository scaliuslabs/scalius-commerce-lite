import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
  getCacheType: vi.fn(() => "kv"),
  search: vi.fn(),
  rateLimit: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.24"),
}));

vi.mock("../utils/kv-cache", () => ({
  getCache: mocks.getCache,
  setCache: mocks.setCache,
  getCacheType: mocks.getCacheType,
  toProjectCacheKey: (key: string) => `sc:${key}`,
}));

vi.mock("@scalius/core/search", () => ({
  sanitizeFtsQuery: (value: string) => {
    const cleaned = value.replace(/["\-*(){}[\]^~:\\/<>|@#&+!?.,'=\u0964\u0965]/g, " ").trim();
    return cleaned ? cleaned.split(/\s+/).map((token) => `${token}*`).join(" ") : "";
  },
  search: mocks.search,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
  rateLimit: mocks.rateLimit,
}));

import { searchRoutes } from "./search";

function withoutFenceToken(cacheKey: string): string {
  return cacheKey.replace(/#f:[0-9a-f]+$/, "");
}

function createTestApp() {
  const db = { id: "db" };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/search", searchRoutes);
  return { app, db };
}

function createCacheEnv() {
  return {
    CACHE: {
      get: vi.fn(),
      put: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as Env;
}

describe("public search route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCache.mockResolvedValue(null);
    mocks.setCache.mockResolvedValue(undefined);
    mocks.getCacheType.mockReturnValue("kv");
    mocks.getClientIp.mockReturnValue("203.0.113.24");
    mocks.rateLimit.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: Date.now() + 60_000,
    });
    mocks.search.mockResolvedValue({
      products: [{ id: "prod_1", name: "Fresh Hilsa", slug: "fresh-hilsa", price: 1200 }],
      pages: [],
      categories: [],
    });
  });

  it("serves cached search hits before the miss-only rate limiter", async () => {
    mocks.getCache.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        success: true,
        data: {
          products: [],
          pages: [],
          categories: [],
          query: "fish",
        },
      }),
    });

    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=fish", {}, createCacheEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Cache")).toBe("HIT");
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("normalizes search query whitespace before cache lookup and FTS work", async () => {
    const { app, db } = createTestApp();
    const response = await app.request(
      "/api/v1/search?q=%20%20Fresh%20%20%20Hilsa%20&limit=4",
      {},
      createCacheEnv(),
    );
    const body = await response.json() as { data?: { query?: string } };

    expect(response.status).toBe(200);
    expect(body.data?.query).toBe("Fresh Hilsa");
    expect(withoutFenceToken(mocks.getCache.mock.calls[0]?.[0] as string)).toBe(
      "api:search:/api/v1/search?limit=4&q=Fresh+Hilsa",
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "search:203.0.113.24",
        limit: 30,
        windowMs: 60_000,
      }),
    );
    expect(mocks.search).toHaveBeenCalledWith(
      db,
      "Fresh Hilsa",
      expect.objectContaining({ limit: 4 }),
    );
  });

  it("treats punctuation-only search as empty before rate limiting or database work", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=!!!!", {}, createCacheEnv());
    const body = await response.json() as { data?: { query?: string; products?: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data?.query).toBe("");
    expect(body.data?.products).toEqual([]);
    expect(withoutFenceToken(mocks.getCache.mock.calls[0]?.[0] as string)).toBe(
      "api:search:/api/v1/search?q=__scalius_invalid_fts_query__",
    );
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects excessive limits before search execution", async () => {
    mocks.getCache.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ success: true, data: { products: [{ id: "stale" }] } }),
    });

    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/search?q=fish&limit=5000",
      {},
      createCacheEnv(),
    );

    expect(response.status).toBe(400);
    expect(mocks.getCache).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it("does not serve default-key cache hits for empty validated query params", async () => {
    mocks.getCache.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ success: true, data: { query: "", products: [] } }),
    });

    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=fish&limit=", {}, createCacheEnv());

    expect(response.status).toBe(400);
    expect(mocks.getCache).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rate limits cache misses before database search", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const { app } = createTestApp();
    const response = await app.request("/api/v1/search?q=fish", {}, createCacheEnv());

    expect(response.status).toBe(429);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.setCache).not.toHaveBeenCalled();
  });
});
