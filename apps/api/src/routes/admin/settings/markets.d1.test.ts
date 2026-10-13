// Settings → Markets routes on the migrated schema: the list and detail the
// dashboard draws, create and edit under the revision, one market per
// country (409), the backup market's rules, delete, the catalogue rebuild a
// price increment change requests, and the RBAC map of every route.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

import { errorResponseFromError } from "../../../utils/api-response";
import { marketsSettingsRoutes } from "./markets";

const rebuild = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../background/catalog", () => ({ rebuildCatalogProjectionsAfterWrite: rebuild }));

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  rebuild.mockClear();
});
afterEach(() => sqlite.close());

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  router.route("/markets", marketsSettingsRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function call(method: string, path: string, body?: unknown) {
  const env = {} as unknown as Env;
  const response = await app().request(`/api/v1/admin/settings/markets${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }, env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} answered ${response.status} ${text.slice(0, 80)}`);
  }
  return { status: response.status, cache: response.headers.get("Cache-Control"), body: parsed as { data: any; error: { code: string; message: string } } };
}

describe("Settings → Markets routes", () => {
  it("lists the backup market and creates, edits and deletes a market", async () => {
    const list = await call("GET", "");
    expect(list.status).toBe(200);
    expect(list.cache).toBe("private, no-store");
    expect(list.body.data.items).toEqual([expect.objectContaining({
      id: "mkt_backup", isBackup: true, status: "active", countries: ["BD"], presence: { value: "", locale: "en" },
      currencyCode: "BDT", priceIncrementMinor: 100, hasOrders: false,
    })]);

    const created = await call("POST", "", { name: "India", status: "draft", countries: ["IN"], presence: { value: "en-in", locale: "en" } });
    expect(created.status).toBe(201);
    const id = created.body.data.market.id as string;
    expect(created.body.data.market).toMatchObject({ handle: "india", status: "draft", revision: 1, priceIncrementInherited: true });

    const activated = await call("PATCH", `/${id}`, { expectedRevision: 1, status: "active", countries: ["IN", "NP"] });
    expect(activated.status).toBe(200);
    expect(activated.body.data.market).toMatchObject({ status: "active", revision: 2, countries: ["IN", "NP"] });
    expect((await call("PATCH", `/${id}`, { expectedRevision: 1, name: "Stale" })).status).toBe(409);
    expect((await call("POST", "", { name: "Nepal", countries: ["NP"] })).status).toBe(409);
    expect((await call("PATCH", `/${id}`, { expectedRevision: 2, priceIncrementMinor: 1 })).status).toBe(400);

    expect((await call("GET", `/${id}`)).body.data.market.name).toBe("India");
    expect((await call("DELETE", `/${id}?expectedRevision=1`)).status).toBe(409);
    expect((await call("DELETE", `/${id}?expectedRevision=2`)).status).toBe(200);
    expect((await call("GET", `/${id}`)).status).toBe(404);
    expect((await call("DELETE", "/mkt_backup?expectedRevision=1")).status).toBe(400);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("requests a catalogue rebuild when the backup market's price increment changes", async () => {
    const paisa = await call("PATCH", "/mkt_backup", { expectedRevision: 1, priceIncrementMinor: 1 });
    expect(paisa.status).toBe(200);
    expect(paisa.body.data.market.priceIncrementMinor).toBe(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(expect.anything(), db, "markets");
    await call("PATCH", "/mkt_backup", { expectedRevision: 2, name: "Bangladesh store" });
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("guards reads with settings view and writes with settings edit", () => {
    expect(getRoutePermission("/api/v1/admin/settings/markets", "GET")).toMatchObject({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission("/api/v1/admin/settings/markets", "POST")).toMatchObject({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
    expect(getRoutePermission("/api/v1/admin/settings/markets/mkt_x", "GET")).toMatchObject({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission("/api/v1/admin/settings/markets/mkt_x", "PATCH")).toMatchObject({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
    expect(getRoutePermission("/api/v1/admin/settings/markets/mkt_x", "DELETE")).toMatchObject({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
  });
});
