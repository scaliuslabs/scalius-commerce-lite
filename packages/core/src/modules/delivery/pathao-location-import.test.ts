import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import {
  pathaoDatasetEntries,
  preparePathaoLocationItems,
  processPathaoImportChunk,
} from "./pathao-location-import";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pathao location import preparation", () => {
  it("normalizes buyer locations and separates provider routing artifacts", () => {
    const result = preparePathaoLocationItems([
      { name: "  Dhanmondi  ", type: "zone", parentPathaoId: 1, pathaoId: 1 },
      { name: "On-demand  transfer", type: "zone", parentPathaoId: 1, pathaoId: 2 },
      { name: "Central Road", type: "zone", parentPathaoId: 1, pathaoId: 3 },
      { name: "lost", type: "zone", parentPathaoId: 1, pathaoId: 4 },
      { name: "Section   10", type: "area", parentPathaoId: 1, pathaoId: 5 },
      { name: "Invalid ID", type: "area", parentPathaoId: 1, pathaoId: 0 },
    ]);

    expect(result.accepted).toMatchObject([
      { name: "Dhanmondi", pathaoId: 1 },
      { name: "Central Road", pathaoId: 3 },
      { name: "Section 10", pathaoId: 5 },
    ]);
    expect(result.rejected).toMatchObject([
      { name: "On-demand transfer", pathaoId: 2 },
      { name: "lost", pathaoId: 4 },
      { name: "Invalid ID", pathaoId: 0 },
    ]);
  });

  it("keeps one deterministic choice for duplicate provider identities", () => {
    const result = preparePathaoLocationItems([
      { name: "Mohakhali Flyover", type: "area", parentPathaoId: 1, pathaoId: 16547 },
      { name: " mohakhali   flyover ", type: "area", parentPathaoId: 1, pathaoId: 16487 },
      { name: "Different label", type: "area", parentPathaoId: 1, pathaoId: 16487 },
      { name: "Mohakhali Flyover", type: "area", parentPathaoId: 2, pathaoId: 16548 },
    ]);

    expect(result.accepted).toMatchObject([
      { name: "mohakhali flyover", parentPathaoId: 1, pathaoId: 16487 },
      { name: "Mohakhali Flyover", parentPathaoId: 2, pathaoId: 16548 },
    ]);
    expect(result.rejected).toHaveLength(2);
  });

  it("emits the dataset shape: keyed places, artifacts inactive, invalid ids left out", () => {
    expect(pathaoDatasetEntries([
      { name: "Mirpur", type: "zone", parentPathaoId: 1, pathaoId: 10 },
      { name: "Bulk Merchant", type: "zone", parentPathaoId: 1, pathaoId: 11 },
      { name: "Section 10", type: "area", parentPathaoId: 10, pathaoId: 100, homeDelivery: true, pickup: false },
      { name: "Nowhere", type: "area", parentPathaoId: 10, pathaoId: 0 },
    ])).toEqual([
      { key: "pathao:zone:10", level: 2, parent: "pathao:city:1", name: "Mirpur", externalIds: { pathao: "10" }, active: true },
      { key: "pathao:area:100", level: 3, parent: "pathao:zone:10", name: "Section 10", externalIds: { pathao: "100" }, active: true, homeDelivery: true, pickup: false },
      { key: "pathao:zone:11", level: 2, parent: "pathao:city:1", name: "Bulk Merchant", externalIds: { pathao: "11" }, active: false },
    ]);
  });
});

describe("Pathao dashboard import", () => {
  const creds = {
    baseUrl: "https://pathao.example.test",
    clientId: "client",
    clientSecret: "secret",
    username: "merchant",
    password: "password",
  };

  function kv() {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
    };
  }

  function pathaoApi() {
    return vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const json = (data: unknown) => new Response(JSON.stringify({ data: { data } }));
      if (path.endsWith("/issue-token")) return new Response(JSON.stringify({ access_token: "token" }));
      if (path.endsWith("/city-list")) return json([{ city_id: 1, city_name: "Dhaka" }, { city_id: 2, city_name: "Chattogram" }]);
      if (path === "/aladdin/api/v1/cities/1/zone-list") return json([{ zone_id: 10, zone_name: "Mirpur" }]);
      if (path === "/aladdin/api/v1/cities/2/zone-list") return json([{ zone_id: 20, zone_name: "Agrabad" }]);
      if (path === "/aladdin/api/v1/zones/10/area-list") return json([{ area_id: 100, area_name: "Section 10", home_delivery_available: true, pickup_available: true }]);
      if (path === "/aladdin/api/v1/zones/20/area-list") return json([]);
      return new Response("not found", { status: 404 });
    });
  }

  it("imports cities, thanas and areas through the place import, keyed for later refreshes", async () => {
    const harness = createSqliteD1Database();
    // A place the store imported before datasets existed: matched by its Pathao id.
    harness.sqlite.exec(`INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata)
      VALUES ('old_dhaka', 'BD', 1, NULL, 'Dhaka City', '{"pathao":"1"}', '{}')`);
    vi.stubGlobal("fetch", pathaoApi());
    const store = kv();
    const steps = [];
    for (let step = 0; step < 6; step += 1) {
      const result = await processPathaoImportChunk(harness.db, store as never, creds);
      steps.push(result.phase);
      if (result.status === "complete") break;
    }
    expect(steps).toEqual(["cities", "zones", "areas", "done"]);
    const rows = harness.sqlite.prepare(
      "SELECT id, level, name, source, source_key AS key, parent_id AS parent, metadata FROM places ORDER BY level, name",
    ).all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.level, row.name, row.key, row.source])).toEqual([
      [1, "Chattogram", "pathao:city:2", "bd"],
      [1, "Dhaka", "pathao:city:1", null],
      [2, "Agrabad", "pathao:zone:20", "bd"],
      [2, "Mirpur", "pathao:zone:10", "bd"],
      [3, "Section 10", "pathao:area:100", "bd"],
    ]);
    expect(rows.find((row) => row.name === "Dhaka")!.id).toBe("old_dhaka");
    expect(rows.find((row) => row.name === "Mirpur")!.parent).toBe("old_dhaka");
    expect(rows.find((row) => row.name === "Section 10")!.metadata).toBe('{"home_delivery_available":true,"pickup_available":true}');
  }, 20_000);
});
