import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getOptionalExecutionContext: vi.fn(),
  invalidateGroups: vi.fn(),
  triggerStorefrontPurgeForGroups: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  getOptionalExecutionContext: mocks.getOptionalExecutionContext,
  invalidateGroups: mocks.invalidateGroups,
  triggerStorefrontPurgeForGroups: mocks.triggerStorefrontPurgeForGroups,
}));

import { heroSlidersRoutes } from "./hero-sliders";

const sliderRecord = {
  id: "slider_1",
  type: "desktop",
  images: JSON.stringify([{ id: "img_1", url: "https://cdn.example.com/hero.jpg", title: "Hero", link: "/" }]),
  isActive: true,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

function createDb(options: { selectResult?: unknown; updateResult?: unknown } = {}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => options.selectResult ?? null,
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [sliderRecord],
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [options.updateResult ?? sliderRecord],
        }),
      }),
    }),
  };
}

function createTestApp(db = createDb()) {
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateGroups.mockResolvedValue(undefined);
  mocks.getOptionalExecutionContext.mockReturnValue(undefined);
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/settings/hero-sliders", heroSlidersRoutes);
  return { app, env };
}

describe("hero slider cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates homepage caches after hero slider saves", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "desktop",
          images: [{ id: "img_1", url: "https://cdn.example.com/hero.jpg", title: "Hero", link: "/" }],
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateGroups).toHaveBeenCalledWith(["homepage"], env.CACHE);
    expect(mocks.triggerStorefrontPurgeForGroups).toHaveBeenCalledWith(["homepage"], env, undefined);
  });

  it("does not invalidate homepage caches after hero slider reads", async () => {
    const { app, env } = createTestApp(createDb({ selectResult: sliderRecord }));

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      { method: "GET" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateGroups).not.toHaveBeenCalled();
    expect(mocks.triggerStorefrontPurgeForGroups).not.toHaveBeenCalled();
  });

  it("invalidates homepage caches after hero slider updates", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateGroups).toHaveBeenCalledWith(["homepage"], env.CACHE);
    expect(mocks.triggerStorefrontPurgeForGroups).toHaveBeenCalledWith(["homepage"], env, undefined);
  });

  it("invalidates homepage caches after hero slider deletes", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      { method: "DELETE" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateGroups).toHaveBeenCalledWith(["homepage"], env.CACHE);
    expect(mocks.triggerStorefrontPurgeForGroups).toHaveBeenCalledWith(["homepage"], env, undefined);
  });
});
