// The public City/Thana/Area pickers read the place directory by country and
// level and answer exactly what they answered before places existed: the same
// fields, in the same order, with the Bangladesh address field as `type`.
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { locationRoutes } from "./locations";

function createTestApp() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active, sort_order) VALUES
      ('dhaka', 'Dhaka', 'BD', 1, NULL, '{"pathao":"1"}', '{}', 1, 1),
      ('ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1, 0),
      ('closed', 'Closed', 'BD', 1, NULL, '{}', '{}', 0, 0),
      ('mirpur', 'Mirpur', 'BD', 2, 'dhaka', '{}', '{}', 1, 0),
      ('s10', 'Section 10', 'BD', 3, 'mirpur', '{}', '{}', 1, 0),
      ('mh', 'Maharashtra', 'IN', 1, NULL, '{}', '{}', 1, 0);
  `);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => {
    c.set("db", harness.db as never);
    await next();
  });
  app.route("/locations", locationRoutes);
  return async (path: string) => (await app.request(`/api/v1/locations${path}`, {}, {} as Env)).text();
}

describe("public delivery location pickers", () => {
  it("lists Bangladesh's active cities, thanas and areas in the same bytes as before", async () => {
    const get = createTestApp();
    expect(await get("/cities")).toBe(JSON.stringify({ success: true, data: [
      { id: "ctg", name: "Chattogram", type: "city", parentId: null, isActive: true, sortOrder: 0 },
      { id: "dhaka", name: "Dhaka", type: "city", parentId: null, isActive: true, sortOrder: 1 },
    ] }));
    expect(await get("/zones?cityId=dhaka")).toBe(JSON.stringify({ success: true, data: [
      { id: "mirpur", name: "Mirpur", type: "zone", parentId: "dhaka", isActive: true, sortOrder: 0 },
    ] }));
    expect(await get("/areas?zoneId=mirpur")).toBe(JSON.stringify({ success: true, data: [
      { id: "s10", name: "Section 10", type: "area", parentId: "mirpur", isActive: true, sortOrder: 0 },
    ] }));
    // A thana's list never holds its areas; a city's list never holds a thana.
    expect(await get("/zones?cityId=mirpur")).toBe(JSON.stringify({ success: true, data: [] }));
    expect(JSON.parse(await get("/cities/summaries?search=dha")).data).toEqual({
      locations: [{ id: "dhaka", name: "Dhaka", type: "city", parentId: null, isActive: true, sortOrder: 1 }],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });
  }); // The first test also builds the migrated SQLite database.
});
