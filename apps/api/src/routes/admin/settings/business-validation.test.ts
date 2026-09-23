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

import { businessSettingsRoutes } from "./business";

let sqlite: DatabaseSync;

function createApp() {
  const database = createSqliteD1Database();
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
  return app.request("/api/v1/admin/settings/business", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function businessInfo() {
  return sqlite.prepare("SELECT key, value FROM settings WHERE category = 'business_info' ORDER BY key").all();
}

describe("Business email route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bumpCacheGeneration.mockResolvedValue(undefined);
  });

  it("rejects malformed email without constructing an aggregate write", async () => {
    const response = await save(createApp(), { email: "support@" });
    const body = await response.json() as { error?: { message?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.message).toContain("valid business support email address");
    expect(businessInfo()).toEqual([]);
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: "  support@example.test  " }, "support@example.test"],
    [{ email: "  " }, ""],
  ] as const)("accepts and normalizes %j", async (body, expectedEmail) => {
    const response = await save(createApp(), body);

    expect(response.status).toBe(200);
    expect(businessInfo()).toEqual([{ key: "email", value: expectedEmail }]);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledOnce();
  });

  it("leaves omitted email out of the aggregate write", async () => {
    const response = await save(createApp(), { companyName: "Merchant" });

    expect(response.status).toBe(200);
    expect(businessInfo()).toEqual([{ key: "company_name", value: "Merchant" }]);
  });
});
