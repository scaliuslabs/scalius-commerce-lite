import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createPlace: vi.fn(),
  deletePlaces: vi.fn(),
  updatePlace: vi.fn(),
  getPlaceById: vi.fn(),
  getCheckoutDeliveryReadiness: vi.fn(),
  resetPathaoImportProgress: vi.fn(),
}));

vi.mock("@scalius/core/modules/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/delivery")>()),
  countPlaceDescendants: vi.fn(async () => new Map()),
  createPlace: mocks.createPlace,
  deletePlaces: mocks.deletePlaces,
  getPlaceById: mocks.getPlaceById,
  updatePlace: mocks.updatePlace,
  getPathaoImportStatus: vi.fn(),
  processPathaoImportChunk: vi.fn(),
  resetPathaoImportProgress: mocks.resetPathaoImportProgress,
}));

vi.mock("@scalius/core/modules/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/checkout")>()),
  getCheckoutDeliveryReadiness: mocks.getCheckoutDeliveryReadiness,
}));

import { adminLocationRoutes } from "./delivery-locations";

function createTestApp(db: Record<string, unknown> = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ get: vi.fn(async () => undefined) })),
    })),
  })),
}) {
  const env = {
    CACHE: { id: "api-cache-kv" },
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.getCheckoutDeliveryReadiness.mockResolvedValue({
    status: "ready",
    hasActiveShippingMethod: true,
    hasActiveDeliveryHierarchy: true,
    issues: [],
  });
  mocks.createPlace.mockResolvedValue({
    id: "loc_1",
    name: "Dhaka",
    countryCode: "BD",
    level: 1,
    parentId: null,
    sourceKey: null,
    source: null,
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

describe("delivery location write behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns success after delivery location saves", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Dhaka",
          countryCode: "BD",
          level: 1,
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

  });

  it("routes Pathao reset to the static import endpoint before the location ID route", async () => {
    mocks.resetPathaoImportProgress.mockResolvedValueOnce(undefined);
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations/import-pathao",
      { method: "DELETE" },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { message: "Import progress reset. You can start a fresh import." },
    });
    expect(mocks.resetPathaoImportProgress).toHaveBeenCalledWith(env.CACHE);
    expect(mocks.getPlaceById).not.toHaveBeenCalled();
  });

  it("trims location names at the request boundary", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "  Dhaka  ",
          countryCode: "BD",
          level: 1,
          parentId: null,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.createPlace).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "Dhaka" }),
    );
  });

  it("rejects blank location names before database work", async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  ", countryCode: "BD", level: 1, parentId: null }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.createPlace).not.toHaveBeenCalled();
  });

  it("rejects an indistinguishable active location under the same parent", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(async () => ({ id: "city_existing" })) })),
        })),
      })),
    };
    const { app, env } = createTestApp(db);
    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: " dhaka ", countryCode: "BD", level: 1, parentId: null }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.createPlace).not.toHaveBeenCalled();
  });

  it("turns a concurrent identity-constraint race into a readable validation error", async () => {
    const { app, env } = createTestApp();
    mocks.createPlace.mockRejectedValueOnce(
      new Error(
        "D1_ERROR: UNIQUE constraint failed: index 'places_active_root_name_uidx'",
      ),
    );

    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Dhaka", countryCode: "BD", level: 1, parentId: null }),
      },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.objectContaining({
        message: "An active location with this name already exists under the same parent.",
      }),
    });
  });

  it("rejects an active zone without an existing parent city", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(async () => undefined) })),
        })),
      })),
    };
    const { app, env } = createTestApp(db);
    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Dhanmondi",
          countryCode: "BD",
          level: 2,
          parentId: "missing-city",
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.createPlace).not.toHaveBeenCalled();
  });

  it("bounds bulk deletion below D1's parameter ceiling", async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      "/api/v1/admin/settings/delivery-locations",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: Array.from({ length: 91 }, (_, index) => `location-${index}`),
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.getCheckoutDeliveryReadiness).not.toHaveBeenCalled();
  });

  it("rejects bulk deleting the last usable city-zone checkout chain", async () => {
    mocks.getCheckoutDeliveryReadiness
      .mockResolvedValueOnce({
        status: "ready",
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: true,
        issues: [],
      })
      .mockResolvedValueOnce({
        status: "incomplete",
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: false,
        issues: [{
          code: "missing_active_delivery_location",
          message: "Add at least one active city with an active thana before checkout can accept orders.",
        }],
      });
    const { app, env } = createTestApp();

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
    expect(mocks.deletePlaces).not.toHaveBeenCalled();
  });
});
