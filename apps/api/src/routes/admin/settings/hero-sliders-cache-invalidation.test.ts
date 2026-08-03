import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { AppError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
  getOptionalExecutionContext: vi.fn(),
  invalidateApiAndStorefrontGroups: vi.fn(),
  listHeroSliders: vi.fn(),
  getHeroSlider: vi.fn(),
  createHeroSlider: vi.fn(),
  updateHeroSlider: vi.fn(),
  deleteHeroSlider: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  getOptionalExecutionContext: mocks.getOptionalExecutionContext,
  invalidateApiAndStorefrontGroups: mocks.invalidateApiAndStorefrontGroups,
}));

vi.mock("@scalius/core/modules/hero-sliders", () => ({
  listHeroSliders: mocks.listHeroSliders,
  getHeroSlider: mocks.getHeroSlider,
  createHeroSlider: mocks.createHeroSlider,
  updateHeroSlider: mocks.updateHeroSlider,
  deleteHeroSlider: mocks.deleteHeroSlider,
}));

import { heroSlidersRoutes } from "./hero-sliders";

const sliderRecord = {
  id: "slider_1",
  type: "desktop",
  images: [{
    id: "img_1",
    url: "https://cdn.example.com/hero.jpg",
    title: "Hero",
    link: "/",
    focalPoint: { x: 50, y: 50 },
  }],
  isActive: true,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

function createDb() {
  return { id: "db" };
}

function createTestApp(db = createDb()) {
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.listHeroSliders.mockResolvedValue([sliderRecord]);
  mocks.getHeroSlider.mockResolvedValue(sliderRecord);
  mocks.createHeroSlider.mockResolvedValue(sliderRecord);
  mocks.updateHeroSlider.mockResolvedValue(sliderRecord);
  mocks.deleteHeroSlider.mockResolvedValue({ ...sliderRecord, isActive: false });
  mocks.invalidateApiAndStorefrontGroups.mockResolvedValue({
    attempted: true,
    ok: true,
    status: 200,
  });
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
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
      ["homepage"],
      env,
      { cleanupExecutionCtx: undefined },
    );
  });

  it("does not invalidate homepage caches after hero slider reads", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      { method: "GET" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndStorefrontGroups).not.toHaveBeenCalled();
  });

  it("invalidates homepage caches after hero slider updates", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, isActive: false }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
      ["homepage"],
      env,
      { cleanupExecutionCtx: undefined },
    );
  });

  it("invalidates homepage caches after hero slider deletes", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
      ["homepage"],
      env,
      { cleanupExecutionCtx: undefined },
    );
  });

  it("preserves the typed stale-write conflict and does not invalidate caches", async () => {
    const { app, env } = createTestApp();
    mocks.updateHeroSlider.mockRejectedValueOnce(new AppError(
      409,
      "HERO_SLIDER_REVISION_CONFLICT",
      "This hero slider changed in another session.",
      { id: "slider_1", expectedRevision: 1, currentRevision: 2 },
    ));

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, isActive: false }),
      },
      env,
    );
    const payload = await response.json() as {
      error?: { code?: string; details?: unknown };
    };

    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({
      code: "HERO_SLIDER_REVISION_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(mocks.invalidateApiAndStorefrontGroups).not.toHaveBeenCalled();
  });
});
