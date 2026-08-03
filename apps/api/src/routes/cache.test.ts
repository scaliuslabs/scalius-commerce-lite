import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INVALIDATION_GROUPS } from "../utils/cache-invalidation";
import { errorResponseFromError } from "../utils/api-response";
import { cacheControlRoutes } from "./cache";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.route("/cache", cacheControlRoutes);
  return app;
}

function createRuntime() {
  const purgeGroups = vi.fn().mockResolvedValue(undefined);
  const executionCtx = {
    waitUntil: vi.fn(),
    exports: { PublicApi: { purgeGroups } },
  };
  const env = {
    PURGE_URL: "https://shop.example/api/purge-cache",
    PURGE_TOKEN: "secret",
  } as never;
  return { env, executionCtx, purgeGroups };
}

describe("cache control routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists the bounded cache domain contract", async () => {
    const response = await createTestApp().request("/api/v1/cache/groups");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { groups: INVALIDATION_GROUPS },
    });
  });

  it("purges all native API and storefront domains", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { env, executionCtx, purgeGroups } = createRuntime();

    const response = await createTestApp().request(
      "/api/v1/cache/clear",
      { method: "POST" },
      env,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(purgeGroups).toHaveBeenCalledWith(Object.keys(INVALIDATION_GROUPS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates valid selected domains", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { env, executionCtx, purgeGroups } = createRuntime();

    const response = await createTestApp().request(
      "/api/v1/cache/clear-group",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: ["products", "unknown", "products"] }),
      },
      env,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(purgeGroups).toHaveBeenCalledWith(["products"]);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { groups: ["products"] },
    });
  });

  it("rejects requests with no valid domains", async () => {
    const response = await createTestApp().request(
      "/api/v1/cache/clear-group",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: ["unknown"] }),
      },
    );
    expect(response.status).toBe(400);
  });
});
