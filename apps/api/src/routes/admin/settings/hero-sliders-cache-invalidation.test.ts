import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndStorefrontGroups: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndStorefrontGroups: mocks.invalidateApiAndStorefrontGroups,
}));

import { heroSlidersRoutes } from "./hero-sliders";

function createDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => null,
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [{
          id: "slider_1",
          type: "desktop",
          images: JSON.stringify([{ id: "img_1", url: "https://cdn.example.com/hero.jpg", title: "Hero", link: "/" }]),
          isActive: true,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        }],
      }),
    }),
  };
}

function createTestApp() {
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateApiAndStorefrontGroups.mockResolvedValue(undefined);
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", createDb() as never);
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
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(["homepage"], env);
  });
});
