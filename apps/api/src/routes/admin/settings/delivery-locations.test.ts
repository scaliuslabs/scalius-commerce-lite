import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";

import { adminLocationRoutes } from "./delivery-locations";
import { shippingMethodsSettingsRoutes } from "./shipping";

/** Nagar (Para → Pallabi, Kazipara, Mirpur-2) and Dhaka (Mirpur), with a rate everywhere else. */
function createTestApp() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active) VALUES
      ('nagar', 'R2-SET Nagar', 'BD', 1, NULL, '{}', '{}', 1),
      ('para', 'R2-SET Para', 'BD', 2, 'nagar', '{}', '{}', 1),
      ('pallabi', 'Pallabi', 'BD', 3, 'para', '{}', '{}', 1),
      ('kazipara', 'Kazipara', 'BD', 3, 'para', '{}', '{}', 1),
      ('mirpur2', 'Mirpur-2', 'BD', 3, 'para', '{}', '{}', 1),
      ('dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
      ('mirpur', 'Mirpur', 'BD', 2, 'dhaka', '{}', '{}', 1);
    INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, is_active, zone_id) VALUES ('sm_else', 'Standard', 6000, 1, 'dz_bd');
  `);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

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
    (harness.sqlite.prepare("SELECT id FROM places WHERE deleted_at IS NULL ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id);
  return { send, live };
}

type Listed = { data: { locations: Array<{ id: string; descendants?: Record<string, number> }> } };

describe("deleting a delivery location", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists how many thanas and areas each city and thana holds", async () => {
    const { send } = createTestApp();
    const cities = await (await send("GET", "/delivery-locations?country=BD&level=1")).json() as Listed;
    // Same sort order: by name, so pages are stable.
    expect(cities.data.locations.map((row) => [row.id, row.descendants])).toEqual([
      ["dhaka", { "2": 1 }],
      ["nagar", { "2": 1, "3": 3 }],
    ]);
    const areas = await (await send("GET", "/delivery-locations?country=BD&level=3&parentId=para")).json() as Listed;
    expect(areas.data.locations.every((row) => row.descendants === undefined)).toBe(true);
  }); // The first test also builds the migrated SQLite database.

  it("deletes a city with its thanas and areas and takes them out of shipping zones", async () => {
    const { send, live } = createTestApp();
    const zone = await send("POST", "/shipping-methods", {
      name: "Nagar",
      locationIds: ["para", "pallabi"],
      rates: [{ name: "Nagar delivery", fee: 80, isActive: true }],
    });
    expect(zone.status).toBe(201);

    const response = await send("DELETE", "/delivery-locations/nagar");

    expect(response.status, await response.clone().text()).toBe(200);

    expect(live()).toEqual(["dhaka", "mirpur"]);
    const zones = await (await send("GET", "/shipping-methods")).json() as { data: { zones: Array<{ locations: unknown[] }> } };
    expect(zones.data.zones[0]!.locations).toEqual([]);
    const thanas = await (await send("GET", "/delivery-locations?country=BD&level=2")).json() as Listed;
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

  });
});

describe("searching delivery locations for a picker", () => {
  type Found = { data: { locations: Array<{ id: string; name: string; parentPath?: string[] }>; pagination: { total: number; totalPages: number } } };
  const names = (found: Found) => found.data.locations.map((row) => row.name);

  it("filters by parent and name, names starting with the term first, with each place's parents", async () => {
    const { send } = createTestApp();
    const found = await (await send("GET", "/delivery-locations?country=BD&level=3&search=pa")).json() as Found;
    // "Pallabi" starts with "pa"; "Kazipara" only contains it.
    expect(names(found)).toEqual(["Pallabi", "Kazipara"]);
    expect(found.data.locations[0]!.parentPath).toEqual(["R2-SET Para", "R2-SET Nagar"]);
    const thanas = await (await send("GET", "/delivery-locations?country=BD&level=2&parentId=dhaka")).json() as Found;
    expect(thanas.data.locations.map((row) => [row.name, row.parentPath])).toEqual([["Mirpur", ["Dhaka"]]]);
  });

  it("matches Bangla names, treats % and _ literally, and pages stably", async () => {
    const { send } = createTestApp();
    await send("POST", "/delivery-locations", { name: "মিরপুর ১০", countryCode: "BD", level: 3, parentId: "mirpur" });
    await send("POST", "/delivery-locations", { name: "Mirpur 100%", countryCode: "BD", level: 3, parentId: "mirpur" });
    const bangla = await (await send("GET", `/delivery-locations?search=${encodeURIComponent("মিরপুর")}`)).json() as Found;
    expect(names(bangla)).toEqual(["মিরপুর ১০"]);
    const percent = await (await send("GET", `/delivery-locations?search=${encodeURIComponent("0%")}`)).json() as Found;
    expect(names(percent)).toEqual(["Mirpur 100%"]);
    const underscore = await (await send("GET", "/delivery-locations?search=_")).json() as Found;
    expect(names(underscore)).toEqual([]);
    const first = await (await send("GET", "/delivery-locations?country=BD&level=3&limit=2&page=1")).json() as Found;
    const second = await (await send("GET", "/delivery-locations?country=BD&level=3&limit=2&page=2")).json() as Found;
    const all = [...names(first), ...names(second)];
    expect(first.data.pagination.total).toBe(5);
    expect(new Set(all).size).toBe(4);
  });

  it("labels a saved choice by ID and can leave out inactive places", async () => {
    const { send } = createTestApp();
    const one = await (await send("GET", "/delivery-locations?id=mirpur2")).json() as Found;
    expect(one.data.locations.map((row) => [row.name, row.parentPath])).toEqual([["Mirpur-2", ["R2-SET Para", "R2-SET Nagar"]]]);
    await send("POST", "/delivery-locations", { name: "Closed", countryCode: "BD", level: 3, parentId: "mirpur", isActive: false });
    const active = await (await send("GET", "/delivery-locations?country=BD&level=3&parentId=mirpur&isActive=true")).json() as Found;
    expect(names(active)).toEqual([]);
    const any = await (await send("GET", "/delivery-locations?country=BD&level=3&parentId=mirpur")).json() as Found;
    expect(names(any)).toEqual(["Closed"]);
  });
});
