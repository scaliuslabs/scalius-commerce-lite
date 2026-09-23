import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn() }));
vi.mock("../utils/cache-generation", () => ({
  bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { cacheControlRoutes } from "./cache";

describe("cache control routes", () => {
  it("refreshes the store by starting a new cache generation", async () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.route("/cache", cacheControlRoutes);
    const env = { CACHE: {} } as unknown as Env;

    const response = await app.request("/api/v1/cache/clear", { method: "POST" }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { message: "Store refreshed" },
    });
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith(expect.objectContaining({ env }));
  });

  it("no longer exposes cache group purges", async () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.route("/cache", cacheControlRoutes);

    expect((await app.request("/api/v1/cache/groups")).status).toBe(404);
    expect((await app.request("/api/v1/cache/clear-group", { method: "POST" })).status).toBe(404);
  });
});
