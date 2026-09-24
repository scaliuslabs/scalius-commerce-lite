import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn() }));

vi.mock("../../../utils/cache-generation", () => ({
  bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { shippingMethodsSettingsRoutes } from "./shipping";
import { shippingMethodRoutes } from "../../shipping-methods";

function createTestApp() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active) VALUES
      ('dhaka', 'Dhaka', 'city', NULL, '{}', '{}', 1),
      ('mirpur', 'Mirpur', 'zone', 'dhaka', '{}', '{}', 1),
      ('ctg', 'Chattogram', 'city', NULL, '{}', '{}', 1);
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

  it("saves a zone, bumps the cache generation and returns it in major units", async () => {
    const { send } = createTestApp();
    const created = await send("POST", "/admin/settings/shipping-methods", insideDhaka);
    expect(created.status).toBe(201);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);

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
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
  });

  it("answers a huge charge with a 400 naming the field, never a 500", async () => {
    const { send } = createTestApp();
    const response = await send("PUT", "/admin/settings/shipping-methods/everywhere-else", {
      expectedRevision: 0,
      rates: [{ name: "Huge", fee: 99_999_999_999, isActive: true }],
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("Enter a charge up to 1,00,000.");
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
  });

  it("rejects a stale zone save with 409", async () => {
    const { send } = createTestApp();
    const { data } = await (await send("POST", "/admin/settings/shipping-methods", insideDhaka)).json() as { data: { id: string } };
    expect((await send("PUT", `/admin/settings/shipping-methods/${data.id}`, { ...insideDhaka, expectedRevision: 1 })).status).toBe(200);
    const stale = await send("PUT", `/admin/settings/shipping-methods/${data.id}`, { ...insideDhaka, name: "Stale", expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "SETTINGS_REVISION_CONFLICT" } });
  });

  it("lists only the rates for the buyer's address on the public route", async () => {
    const { send } = createTestApp();
    await send("POST", "/admin/settings/shipping-methods", insideDhaka);
    await send("PUT", "/admin/settings/shipping-methods/everywhere-else", {
      expectedRevision: 0,
      rates: [{ name: "Outside Dhaka", fee: 120, isActive: true }],
    });
    const names = async (query: string) => {
      const body = await (await send("GET", `/shipping-methods${query}`)).json() as {
        data: { shippingMethods: Array<{ name: string; fee: number; freeOver: number | null; kind: string }> };
      };
      return body.data.shippingMethods.map((rate) => `${rate.name} ${rate.fee}/${rate.freeOver}/${rate.kind}`);
    };
    expect(await names("?cityId=dhaka&zoneId=mirpur")).toEqual(["Inside Dhaka 60/1500/delivery"]);
    expect(await names("?cityId=ctg")).toEqual(["Outside Dhaka 120/null/delivery"]);
    expect(await names("")).toHaveLength(2);
  });
});
