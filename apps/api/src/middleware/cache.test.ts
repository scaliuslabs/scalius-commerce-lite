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

import { cacheMiddleware } from "./cache";

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
});
