import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndStorefrontGroups: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndStorefrontGroups: mocks.invalidateApiAndStorefrontGroups,
}));

import { shippingMethodsSettingsRoutes } from "./shipping";

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
          id: "sm_1",
          name: "Inside Dhaka",
          fee: 60,
          description: null,
          isActive: true,
          sortOrder: 0,
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
  app.route("/admin/settings/shipping-methods", shippingMethodsSettingsRoutes);
  return { app, env };
}

describe("shipping settings cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates checkout caches after shipping method saves", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/shipping-methods",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Inside Dhaka",
          fee: 60,
          isActive: true,
          sortOrder: 0,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(["checkout"], env);
  });
});
