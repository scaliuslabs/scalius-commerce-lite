import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn() }));

vi.mock("../../../utils/cache-generation", () => ({
  bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { adminLocationRoutes } from "./delivery-locations";
import { shippingMethodsSettingsRoutes } from "./shipping";

/** Nagar (Para → Pallabi, Kazipara, Mirpur-2) and Dhaka (Mirpur), with a rate everywhere else. */
function createTestApp() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active) VALUES
      ('nagar', 'R2-SET Nagar', 'city', NULL, '{}', '{}', 1),
      ('para', 'R2-SET Para', 'zone', 'nagar', '{}', '{}', 1),
      ('pallabi', 'Pallabi', 'area', 'para', '{}', '{}', 1),
      ('kazipara', 'Kazipara', 'area', 'para', '{}', '{}', 1),
      ('mirpur2', 'Mirpur-2', 'area', 'para', '{}', '{}', 1),
      ('dhaka', 'Dhaka', 'city', NULL, '{}', '{}', 1),
      ('mirpur', 'Mirpur', 'zone', 'dhaka', '{}', '{}', 1);
    INSERT INTO shipping_methods (id, name, fee_minor, is_active) VALUES ('sm_else', 'Standard', 6000, 1);
  `);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  mocks.bumpCacheGeneration.mockResolvedValue(undefined);
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", harness.db as never);
    await next();
  });
  app.route("/admin/settings/delivery-locations", adminLocationRoutes);
  app.route("/admin/settings/shipping-methods", shippingMethodsSettingsRoutes);
  const send = (method: string, path: string, body?: unknown) => app.request(`/api/v1/admin/settings${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, {} as Env);
  const live = () =>
    (harness.sqlite.prepare("SELECT id FROM delivery_locations WHERE deleted_at IS NULL ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id);
  return { send, live };
}

type Listed = { data: { locations: Array<{ id: string; descendants?: { zones: number; areas: number } }> } };

describe("deleting a delivery location", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists how many thanas and areas each city and thana holds", async () => {
    const { send } = createTestApp();
    const cities = await (await send("GET", "/delivery-locations?type=city")).json() as Listed;
    expect(cities.data.locations.map((row) => [row.id, row.descendants])).toEqual([
      ["nagar", { zones: 1, areas: 3 }],
      ["dhaka", { zones: 1, areas: 0 }],
    ]);
    const areas = await (await send("GET", "/delivery-locations?type=area&parentId=para")).json() as Listed;
    expect(areas.data.locations.every((row) => row.descendants === undefined)).toBe(true);
  }, 20_000); // The first test also builds the migrated SQLite database.

  it("deletes a city with its thanas and areas and takes them out of shipping zones", async () => {
    const { send, live } = createTestApp();
    const zone = await send("POST", "/shipping-methods", {
      name: "Nagar",
      locationIds: ["para", "pallabi"],
      rates: [{ name: "Nagar delivery", fee: 80, isActive: true }],
    });
    expect(zone.status).toBe(201);
    mocks.bumpCacheGeneration.mockClear();

    const response = await send("DELETE", "/delivery-locations/nagar");

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
    expect(live()).toEqual(["dhaka", "mirpur"]);
    const zones = await (await send("GET", "/shipping-methods")).json() as { data: { zones: Array<{ locations: unknown[] }> } };
    expect(zones.data.zones[0]!.locations).toEqual([]);
    const thanas = await (await send("GET", "/delivery-locations?type=zone")).json() as Listed;
    expect(thanas.data.locations.map((row) => row.id)).toEqual(["mirpur"]);
  });

  it("deletes selected thanas with their areas", async () => {
    const { send, live } = createTestApp();
    const response = await send("DELETE", "/delivery-locations", { ids: ["para"] });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(live()).toEqual(["dhaka", "mirpur", "nagar"]);
  });

  it("still refuses to delete the last city a working checkout depends on", async () => {
    const { send, live } = createTestApp();
    expect((await send("DELETE", "/delivery-locations/nagar")).status).toBe(200);
    const response = await send("DELETE", "/delivery-locations/dhaka");
    expect(response.status).toBe(400);
    expect(live()).toEqual(["dhaka", "mirpur"]);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
  });
});
