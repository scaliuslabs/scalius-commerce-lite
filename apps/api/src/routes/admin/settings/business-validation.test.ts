import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  bumpCacheGeneration: vi.fn(),
}));

vi.mock("../../../utils/cache-generation", () => ({
  bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import { saveAllowedCountries } from "@scalius/core/modules/settings/site-settings.service";
import { businessSettingsRoutes } from "./business";

let sqlite: DatabaseSync;
let database: ReturnType<typeof createSqliteD1Database>;

function createApp() {
  database = createSqliteD1Database();
  sqlite = database.sqlite;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", database.db);
    await next();
  });
  app.route("/admin/settings", businessSettingsRoutes);
  return app;
}

async function save(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  const current = await app.request("/api/v1/admin/settings/business");
  const { revision } = (await current.json() as { data: { revision: number } }).data;
  return app.request("/api/v1/admin/settings/business", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, expectedRevision: revision }),
  });
}

/** The stored business document, or null before the first save. */
function businessInfo(): Record<string, string> | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE category = 'business'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Record<string, string> : null;
}

describe("Business email route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bumpCacheGeneration.mockResolvedValue(undefined);
  });

  it("rejects a malformed email and a junk phone together, each against its field, without writing", async () => {
    const response = await save(createApp(), { email: "support@", phone: "123" });
    const body = await response.json() as { error?: { details?: { issues?: Array<{ path: string[] }> } } };

    expect(response.status).toBe(400);
    expect(body.error?.details?.issues?.map((issue) => issue.path.join("."))).toEqual(["email", "phone"]);
    expect(businessInfo()).toBeNull();
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
  });

  it.each([
    ["+880 1712-345678", "01712345678"],
    ["০১৭১২-৩৪৫৬৭৮", "01712345678"],
    ["8801912345678", "01912345678"],
    ["+44 20 7946 0958", "+442079460958"],
    ["  ", ""],
  ])("saves the phone %j as %j", async (phone, stored) => {
    const response = await save(createApp(), { phone });

    expect(response.status).toBe(200);
    expect(businessInfo()).toMatchObject({ phone: stored });
  });

  it("refuses a number from a country the store doesn't accept", async () => {
    const app = createApp();
    await saveAllowedCountries(database.db, ["BD"], "include");

    const foreign = await save(app, { phone: "+44 20 7946 0958" });
    expect(foreign.status).toBe(400);
    expect(businessInfo()).toBeNull();
    expect((await save(app, { phone: "01712345678" })).status).toBe(200);
  });

  it.each([
    [{ email: "  support@example.test  " }, "support@example.test"],
    [{ email: "  " }, ""],
  ] as const)("accepts and normalizes %j", async (body, expectedEmail) => {
    const response = await save(createApp(), body);

    expect(response.status).toBe(200);
    expect(businessInfo()).toMatchObject({ email: expectedEmail, companyName: "" });
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledOnce();
  });

  it("keeps omitted fields when saving others", async () => {
    const app = createApp();
    await save(app, { email: "support@example.test" });
    const response = await save(app, { companyName: "Merchant" });

    expect(response.status).toBe(200);
    expect(businessInfo()).toMatchObject({ companyName: "Merchant", email: "support@example.test" });
  });
});
