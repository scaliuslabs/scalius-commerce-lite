import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { AppError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({

  listHeroSliders: vi.fn(),
  getHeroSlider: vi.fn(),
  createHeroSlider: vi.fn(),
  updateHeroSlider: vi.fn(),
  deleteHeroSlider: vi.fn(),
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
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.listHeroSliders.mockResolvedValue([sliderRecord]);
  mocks.getHeroSlider.mockResolvedValue(sliderRecord);
  mocks.createHeroSlider.mockResolvedValue(sliderRecord);
  mocks.updateHeroSlider.mockResolvedValue(sliderRecord);
  mocks.deleteHeroSlider.mockResolvedValue({ ...sliderRecord, isActive: false });

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

describe("hero slider write behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns success after hero slider saves", async () => {
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

  });

  it("returns the saved hero sliders", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/hero-sliders/slider_1",
      { method: "GET" },
      env,
    );

    expect(response.status).toBe(200);

  });

  it("returns success after hero slider updates", async () => {
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

  });

  it("returns success after hero slider deletes", async () => {
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

  });

  it("preserves the typed stale-write conflict", async () => {
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

  });
});
