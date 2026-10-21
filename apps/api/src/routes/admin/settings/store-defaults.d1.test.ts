import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../../../utils/api-response";
import { TEST_WORKER_VERSION, stubSettingsMirror } from "../../../testing/settings-mirror";
import { storeDefaultsSettingsRoutes } from "./store-defaults";

const rebuild = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../background/catalog", () => ({ rebuildCatalogProjectionsAfterWrite: rebuild }));

describe("store defaults and store setup routes", () => {
  let sqlite: DatabaseSync;
  let app: OpenAPIHono<{ Bindings: Env }>;
  let env: Env;
  let mirror: ReturnType<typeof stubSettingsMirror>;

  beforeEach(() => {
    const created = createSqliteD1Database();
    sqlite = created.sqlite;
    mirror = stubSettingsMirror();
    env = {
      CF_VERSION_METADATA: { id: TEST_WORKER_VERSION },
    } as unknown as Env;
    app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", created.db as never);
      await next();
    });
    app.route("/admin/settings", storeDefaultsSettingsRoutes);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    rebuild.mockClear();
    vi.unstubAllGlobals();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api/v1/admin/settings${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }, env);
    return { status: response.status, body: await response.json() as { data?: Record<string, unknown>; error?: { code?: string } } };
  };

  it("reads and saves the time zone and units at the platform revision", async () => {
    const read = await call("GET", "/store-defaults");
    expect(read).toMatchObject({ status: 200, body: { data: { timeZone: "Asia/Dhaka", unitSystem: "metric", weightUnit: "g", revision: 0, countryCode: "BD" } } });

    const saved = await call("POST", "/store-defaults", { expectedRevision: 0, timeZone: "Europe/London", unitSystem: "imperial" });
    expect(saved).toMatchObject({ status: 200, body: { data: { timeZone: "Europe/London", unitSystem: "imperial", weightUnit: "lb", revision: 1 } } });
    expect(mirror.read("settings:platform")).toContain("Europe/London");

    expect((await call("POST", "/store-defaults", { expectedRevision: 0, timeZone: "UTC" })).status).toBe(409);
    expect((await call("POST", "/store-defaults", { expectedRevision: 1, timeZone: "Mars/Olympus" })).status).toBe(400);
  });

  it("sets up a new store once and rebuilds card prices when the increment changes", async () => {
    const status = await call("GET", "/store-setup");
    expect(status).toMatchObject({ status: 200, body: { data: { needed: true, current: { countryCode: "BD", currencyCode: "BDT" } } } });

    const applied = await call("POST", "/store-setup", { storeName: "Maison", countryCode: "FR", timeZone: "Europe/Paris" });
    expect(applied).toMatchObject({
      status: 200,
      body: { data: { countryCode: "FR", currencyCode: "EUR", unitSystem: "metric", weightUnit: "kg", timeZone: "Europe/Paris" } },
    });
    expect(rebuild).toHaveBeenCalledTimes(1);

    const again = await call("POST", "/store-setup", { storeName: "Maison", countryCode: "FR", timeZone: "Europe/Paris" });
    expect(again).toMatchObject({ status: 409, body: { error: { code: "store_setup_done" } } });
    expect((await call("GET", "/store-setup")).body.data).toMatchObject({ needed: false, done: "markets_configured" });
    // The dashboard formats and starts its weeks by the store's country.
    expect((await call("GET", "/store-defaults")).body.data).toMatchObject({ countryCode: "FR" });
  });
});
