import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";

import { shippingMethodsSettingsRoutes } from "./shipping";
import { shippingMethodRoutes } from "../../shipping-methods";

function createTestApp() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active) VALUES
      ('dhaka', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
      ('mirpur', 'Mirpur', 'BD', 2, 'dhaka', '{}', '{}', 1),
      ('ctg', 'Chattogram', 'BD', 1, NULL, '{}', '{}', 1);
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
  app.route("/admin/settings/shipping-methods", shippingMethodsSettingsRoutes);
  app.route("/shipping-methods", shippingMethodRoutes);
  const send = (method: string, path: string, body?: unknown) => app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, {} as Env);
  return { send };
}

const insideDhaka = {
  name: "Inside Dhaka",
  locationIds: ["dhaka"],
  rates: [{ name: "Inside Dhaka", fee: 60, freeOver: 1500, isActive: true }],
};

describe("delivery zone settings API", () => {
  afterEach(() => vi.clearAllMocks());

  it("saves a zone, returns it in major units", async () => {
    const { send } = createTestApp();
    const created = await send("POST", "/admin/settings/shipping-methods", insideDhaka);
    expect(created.status).toBe(201);

    const list = await (await send("GET", "/admin/settings/shipping-methods")).json() as {
      data: { zones: Array<{ name: string; locations: Array<{ id: string }>; rates: Array<{ fee: number; freeOver: number }> }> };
    };
    expect(list.data.zones).toMatchObject([
      { name: "Inside Dhaka", locations: [{ id: "dhaka" }], rates: [{ fee: 60, freeOver: 1500 }] },
    ]);
  }, 20_000); // The first test also builds the migrated SQLite database; give it room under a loaded suite.

  it("refuses paisa in a taka charge with a 400 naming the field", async () => {
    const { send } = createTestApp();
    const response = await send("POST", "/admin/settings/shipping-methods", {
      ...insideDhaka,
      rates: [{ name: "Inside Dhaka", fee: 60.5, freeOver: 1500, isActive: true }],
    });
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("Taka amounts are whole numbers.");
    expect(body).toContain("fee");

  });

  it("keeps calculated rates on delivery and rejects malformed courier identities", async () => {
    const { send } = createTestApp();
    const pickup = await send("PUT", "/admin/settings/shipping-methods/pickup", {
      expectedRevision: 0,
      rates: [{ name: "Pickup", fee: 0, kind: "pickup", pickupAddress: "House 1", isActive: true, rateSource: "example.courier:express" }],
    });
    expect(pickup.status).toBe(400);
    expect(JSON.stringify(await pickup.json())).toContain("Pickup uses a fixed charge.");

    for (const fields of [{ rateSource: "unqualified" }, { rateSource: "flat", fallbackFee: 60 }, { rateSource: "flat", rateService: "express" }]) {
      const response = await send("POST", "/admin/settings/shipping-methods", {
        ...insideDhaka,
        rates: [{ ...insideDhaka.rates[0], ...fields }],
      });
      expect(response.status).toBe(400);
    }
  });

  it("round-trips courier rates with an optional fallback in major units", async () => {
    const { send } = createTestApp();
    const response = await send("POST", "/admin/settings/shipping-methods", {
      ...insideDhaka,
      rates: [{ name: "Courier delivery", fee: 0, isActive: true, rateSource: "example.courier:express", rateService: "next-day", fallbackFee: 90 }],
    });
    expect(response.status).toBe(201);
    const list = await (await send("GET", "/admin/settings/shipping-methods")).json() as { data: { zones: Array<{ rates: unknown[] }> } };
    expect(list.data.zones[0]?.rates).toMatchObject([
      { name: "Courier delivery", fee: 0, rateSource: "example.courier:express", rateService: "next-day", fallbackFee: 90 },
    ]);
    const invalid = await send("POST", "/admin/settings/shipping-methods", {
      ...insideDhaka,
      rates: [{ name: "Courier delivery", fee: 0, isActive: true, rateSource: "example.courier:express", fallbackFee: 90.5 }],
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).toContain("fallbackFee");
  });

  it("answers a huge charge with a 400 naming the field, never a 500", async () => {
    const { send } = createTestApp();
    const response = await send("PUT", "/admin/settings/shipping-methods/pickup", {
      expectedRevision: 0,
      rates: [{ name: "Huge", fee: 99_999_999_999, kind: "pickup", pickupAddress: "House 1", isActive: true }],
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("Enter a charge up to 1,00,000.");

  });

  it("rejects a stale zone save with 409", async () => {
    const { send } = createTestApp();
    const { data } = await (await send("POST", "/admin/settings/shipping-methods", insideDhaka)).json() as { data: { id: string } };
    expect((await send("PUT", `/admin/settings/shipping-methods/${data.id}`, { ...insideDhaka, expectedRevision: 1 })).status).toBe(200);
    const stale = await send("PUT", `/admin/settings/shipping-methods/${data.id}`, { ...insideDhaka, name: "Stale", expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "SETTINGS_REVISION_CONFLICT" } });
  });

  it("lists only the rates for the buyer's destination on the public route, at home and abroad", async () => {
    const { send } = createTestApp();
    await send("POST", "/admin/settings/shipping-methods", insideDhaka);
    expect((await send("POST", "/admin/settings/shipping-methods", {
      name: "Bangladesh",
      regions: [{ countryCode: "BD" }],
      rates: [{ name: "Outside Dhaka", fee: 120, isActive: true }],
    })).status).toBe(201);
    expect((await send("POST", "/admin/settings/shipping-methods", {
      name: "West coast",
      regions: [{ countryCode: "US", adminArea: "California" }, { countryCode: "US", postalPrefix: "97" }],
      rates: [{ name: "West coast", fee: 900, isActive: true }],
    })).status).toBe(201);
    expect((await send("PUT", "/admin/settings/shipping-methods/pickup", {
      expectedRevision: 0,
      rates: [{ name: "Shop pickup", fee: 0, kind: "pickup", pickupAddress: "House 1, Dhanmondi", isActive: true }],
    })).status).toBe(200);
    const rates = async (query: string) => {
      const body = await (await send("GET", `/shipping-methods${query}`)).json() as {
        data: { shippingMethods: Array<{ name: string; fee: number; freeOver: number | null; kind: string; countries: Array<{ code: string; entire: boolean }> }> };
      };
      return body.data.shippingMethods;
    };
    const names = async (query: string) =>
      (await rates(query)).map((rate) => `${rate.name} ${rate.fee}/${rate.freeOver}/${rate.kind}`);
    expect(await names("?cityId=dhaka&zoneId=mirpur")).toEqual(["Inside Dhaka 60/1500/delivery", "Shop pickup 0/null/pickup"]);
    expect(await names("?cityId=ctg")).toEqual(["Outside Dhaka 120/null/delivery", "Shop pickup 0/null/pickup"]);
    // Rates list in sort order, then by name.
    expect(await names("?countryCode=US&adminArea=CA&postalCode=94103")).toEqual(["Shop pickup 0/null/pickup", "West coast 900/null/delivery"]);
    expect(await names("?countryCode=us&postalCode=97201")).toEqual(["Shop pickup 0/null/pickup", "West coast 900/null/delivery"]);
    // No zone serves New York: no delivery rate (fail closed), pickup stays.
    expect(await names("?countryCode=US&adminArea=NY")).toEqual(["Shop pickup 0/null/pickup"]);
    expect((await rates("")).map((rate) => [rate.name, rate.countries])).toEqual([
      ["Inside Dhaka", [{ code: "BD", entire: false }]],
      ["Outside Dhaka", [{ code: "BD", entire: false }]],
      ["Shop pickup", []],
      ["West coast", [{ code: "US", entire: false }]],
    ]);
    expect((await send("GET", "/shipping-methods?countryCode=USA")).status).toBe(400);

    const list = await (await send("GET", "/admin/settings/shipping-methods")).json() as {
      data: { zones: Array<{ name: string; regions: unknown[] }>; pickup: { revision: number; rates: Array<{ name: string }> } };
    };
    expect(list.data.zones.find((zone) => zone.name === "West coast")?.regions).toEqual([
      { countryCode: "US", adminArea: null, postalPrefix: "97" },
      { countryCode: "US", adminArea: "CA", postalPrefix: null },
    ]);
    expect(list.data.pickup).toMatchObject({ revision: 1, rates: [{ name: "Shop pickup" }] });
  });
});
