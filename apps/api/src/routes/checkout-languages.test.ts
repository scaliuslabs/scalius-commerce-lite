import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { checkoutLanguageRoutes, publicCheckoutLanguageRoutes } from "./checkout-languages";

function createTestApp() {
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const insertReturning = vi.fn().mockResolvedValue([{
    id: "cl_1",
    name: "English",
    code: "en",
    languageData: "{}",
    fieldVisibility: "{}",
    isActive: true,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }]);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => null,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: insertReturning,
        }),
      }),
    } as unknown as Database;
    c.set("db", db);
    await next();
  });
  app.route("/checkout-languages", publicCheckoutLanguageRoutes);
  app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  return { app, env };
}

describe("checkout language route boundaries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps public checkout-language mutations unregistered", async () => {
    const { app } = createTestApp();

    const createResponse = await app.request("/api/v1/checkout-languages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const updateResponse = await app.request("/api/v1/checkout-languages/cl_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "English" }),
    });
    const deleteResponse = await app.request("/api/v1/checkout-languages/cl_1", {
      method: "DELETE",
    });
    const restoreResponse = await app.request(
      "/api/v1/checkout-languages/cl_1/restore",
      { method: "POST" },
    );

    expect(createResponse.status).toBe(404);
    expect(updateResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(restoreResponse.status).toBe(404);
  });

  it("leaves admin checkout-language mutations registered", async () => {
    const { app } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
  });

  it("keeps the active checkout language public read available", async () => {
    const { app } = createTestApp();

    const response = await app.request("/api/v1/checkout-languages/active");
    const body = await response.json() as {
      success: boolean;
      data?: { language?: { id?: string } };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.language?.id).toBe("fallback");
  });

  it("invalidates checkout caches after admin checkout-language saves", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "English",
          code: "en",
          languageData: {},
          fieldVisibility: {},
          isActive: true,
          isDefault: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });
});
