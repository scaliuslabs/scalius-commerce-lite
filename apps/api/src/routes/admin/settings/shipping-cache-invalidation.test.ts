import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getCheckoutReadiness: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/settings/checkout-readiness", () => ({
  getCheckoutReadiness: mocks.getCheckoutReadiness,
}));

import { shippingMethodsSettingsRoutes } from "./shipping";

function createDb(existingMethod: { id: string; isActive?: boolean; deletedAt?: null | number } | null = null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => existingMethod,
        }),
      }),
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
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

function createTestApp(db = createDb()) {
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  mocks.getCheckoutReadiness.mockResolvedValue({
    ready: true,
    hasActiveShippingMethod: true,
    hasActiveDeliveryHierarchy: true,
    issues: [],
  });
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
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
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("rejects deleting the last active shipping method from a ready checkout", async () => {
    mocks.getCheckoutReadiness
      .mockResolvedValueOnce({
        ready: true,
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: true,
        issues: [],
      })
      .mockResolvedValueOnce({
        ready: false,
        hasActiveShippingMethod: false,
        hasActiveDeliveryHierarchy: true,
        issues: ["Add at least one active shipping method before checkout can accept orders."],
      });
    const db = createDb({ id: "sm_1", isActive: true, deletedAt: null });
    const { app, env } = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/settings/shipping-methods/sm_1",
      { method: "DELETE" },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
      },
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});
