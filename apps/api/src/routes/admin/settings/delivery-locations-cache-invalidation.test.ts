import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  createLocation: vi.fn(),
  getLocationById: vi.fn(),
  getCheckoutReadiness: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/delivery/locations", () => ({
  createLocation: mocks.createLocation,
  getLocationById: mocks.getLocationById,
}));

vi.mock("@scalius/core/modules/settings/checkout-readiness", () => ({
  getCheckoutReadiness: mocks.getCheckoutReadiness,
}));

import { adminLocationRoutes } from "./delivery-locations";

function createTestApp(db: Record<string, unknown> = { id: "db" }) {
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
  mocks.createLocation.mockResolvedValue({
    id: "loc_1",
    name: "Dhaka",
    type: "city",
    parentId: null,
    externalIds: {},
    metadata: {},
    isActive: true,
    sortOrder: 0,
  });

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/settings/delivery-locations", adminLocationRoutes);
  return { app, env };
}

describe("delivery location cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates checkout caches after delivery location saves", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Dhaka",
          type: "city",
          parentId: null,
          externalIds: {},
          metadata: {},
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

  it("rejects bulk deleting the last usable city-zone checkout chain", async () => {
    mocks.getCheckoutReadiness
      .mockResolvedValueOnce({
        ready: true,
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: true,
        issues: [],
      })
      .mockResolvedValueOnce({
        ready: false,
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: false,
        issues: ["Add at least one active city with an active zone before checkout can accept orders."],
      });
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    };
    const { app, env } = createTestApp(db);

    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["city_1"] }),
      },
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
