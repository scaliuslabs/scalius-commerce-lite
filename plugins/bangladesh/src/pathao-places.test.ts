// Pathao's live places in the pack: the name rules and the dataset shape, and
// the store's bounded, resumable refresh through the place import port.
// Pathao's API and the import are scripted.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import pack from "./index";
import {
  STEP_CALLS,
  pathaoDatasetEntries,
  preparePathaoLocationItems,
  shouldSuppressPathaoLocationName,
} from "./pathao-places";
import type { PlaceEntry } from "./places";

describe("Pathao place names", () => {
  it("suppresses provider placeholders and Pathao routing buckets", () => {
    for (const name of ["lost", " Unknown ", "Bulk Merchant", "Central Fulfillment", "Document-Central", "On-Demand-Chattogram", "On-demand  transfer", "Pathao Central Inbound", "banani hq"]) {
      expect(shouldSuppressPathaoLocationName(name, "zone"), name).toBe(true);
    }
  });

  it("keeps legitimate places that share ordinary words with routing buckets", () => {
    for (const name of ["Central Road", "Central Girls School", "Waste Transfer Point Mirpur 10", "Pathao Office Ashuganj", "On Demand Road"]) {
      expect(shouldSuppressPathaoLocationName(name, "area"), name).toBe(false);
    }
    expect(shouldSuppressPathaoLocationName("Central Road", "zone")).toBe(false);
  });
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

describe("refresh from Pathao", () => {
  const settings = {
    pathao_client_id: "client",
    pathao_client_secret: "secret",
    pathao_username: "merchant@shop.test",
    pathao_password: "password",
  };

  function store(zonesPerCity = 1) {
    const imports: Array<{ version: string; places: PlaceEntry[]; finish?: boolean; source: string }> = [];
    const pathaoCalls: string[] = [];
    const cities = [{ city_id: 1, city_name: "Dhaka" }, { city_id: 2, city_name: "Chattogram" }];
    const instance = createPluginTestHarness(pack, {
      settings,
      fetch: (url) => {
        const path = new URL(url).pathname;
        pathaoCalls.push(path);
        const data = (rows: unknown[]) => ({ status: 200, body: JSON.stringify({ data: { data: rows } }) });
        if (path.endsWith("/issue-token")) return { status: 200, body: JSON.stringify({ access_token: "token" }) };
        if (path.endsWith("/city-list")) return data(cities);
        const city = /\/cities\/(\d+)\/zone-list$/.exec(path);
        if (city) return data(Array.from({ length: zonesPerCity }, (_, index) => ({ zone_id: Number(city[1]) * 1000 + index, zone_name: `Zone ${city[1]}-${index}` })));
        const zone = /\/zones\/(\d+)\/area-list$/.exec(path);
        if (zone) return data([{ area_id: Number(zone[1]) * 10, area_name: `Area ${zone[1]}`, home_delivery_available: true, pickup_available: false }]);
        return { status: 404, body: "{}" };
      },
      api: (operationId, input) => {
        expect(operationId).toBe("dashboard.delivery_locations.import");
        const body = (input as { body: { version: string; places: PlaceEntry[]; finish?: boolean; source: string } }).body;
        imports.push(body);
        return { ok: true, status: 200, data: { created: body.places.length, updated: 0, unchanged: 0, skipped: 0, deactivated: 0, conflicts: [], conflictCount: 0 }, error: null };
      },
    });
    return { instance, imports, pathaoCalls };
  }

  it("reads cities, thanas and areas into the places through the import, never finishing a version", async () => {
    const { instance, imports } = store();
    const result = await instance.route("admin", "refresh-pathao-places", { method: "POST" });
    expect(result.ok).toBe(true);
    const places = imports.flatMap((call) => call.places);
    expect(places.map((place) => place.key)).toEqual([
      "pathao:city:1", "pathao:city:2", "pathao:zone:1000", "pathao:zone:2000", "pathao:area:10000", "pathao:area:20000",
    ]);
    expect(places.find((place) => place.key === "pathao:area:10000")).toMatchObject({ parent: "pathao:zone:1000", externalIds: { pathao: "10000" }, homeDelivery: true, pickup: false });
    expect(imports.every((call) => call.source === "bd" && call.finish === undefined && call.version.startsWith("pathao-"))).toBe(true);
  });

  it("reads Pathao a little at a time and the job finishes what a step left", async () => {
    const { instance, pathaoCalls } = store(40);
    await instance.route("admin", "refresh-pathao-places", { method: "POST" });
    expect(pathaoCalls.length).toBeLessThanOrEqual(STEP_CALLS);
    for (let run = 0; run < 10; run += 1) await instance.cron("pathao-places");
    const zones = 2 * 40;
    // One token per step, the city list, every city's zones, every zone's areas.
    expect(pathaoCalls.filter((path) => path.endsWith("/area-list"))).toHaveLength(zones);
    expect(pathaoCalls.filter((path) => path.endsWith("/zone-list"))).toHaveLength(2);
    const page = await instance.route("admin", "places");
    expect(JSON.stringify(page.value)).toContain("Refreshed");
  });

  it("does nothing on its job until a merchant starts a refresh, and says what is missing without Pathao's keys", async () => {
    const { instance, pathaoCalls } = store();
    await instance.cron("pathao-places");
    expect(pathaoCalls).toHaveLength(0);
    const bare = createPluginTestHarness(pack, {});
    const result = await bare.route("admin", "refresh-pathao-places", { method: "POST" });
    expect(JSON.stringify(result.value)).toContain("Enter Pathao");
  });
});
