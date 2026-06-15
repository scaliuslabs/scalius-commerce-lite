import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  createLocation: vi.fn(),
  getLocationById: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/delivery/locations", () => ({
  createLocation: mocks.createLocation,
  getLocationById: mocks.getLocationById,
}));

import { adminLocationRoutes } from "./delivery-locations";

function createTestApp() {
  const db = { id: "db" };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
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
});
