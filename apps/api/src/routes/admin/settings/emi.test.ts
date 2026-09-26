import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

import { errorResponseFromError } from "../../../utils/api-response";

import { emiSettingsRoutes } from "./emi";

function createApp() {
  const database = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", database.db);
    await next();
  });
  app.route("/admin/settings", emiSettingsRoutes);
  return (body?: unknown) => app.request("/api/v1/admin/settings/emi", body === undefined
    ? {}
    : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const plan = { id: "city-6", provider: "City Bank", months: 6, feePercentage: 3, minAmount: 5000 };

describe("EMI plans settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is off by default, saves under the revision it loaded, and refreshes product pages", async () => {
    const request = createApp();
    await expect((await request()).json()).resolves.toMatchObject({ data: { enabled: false, plans: [], revision: 0 } });

    const saved = await request({ enabled: true, plans: [plan], expectedRevision: 0 });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ data: { enabled: true, plans: [plan], revision: 1 } });

    expect((await request({ enabled: false, plans: [], expectedRevision: 0 })).status).toBe(409);
    expect((await request({ enabled: true, plans: [{ ...plan, minAmount: 4999.5 }], expectedRevision: 1 })).status).toBe(400);
    expect((await request({ enabled: true, plans: [{ ...plan, bank: "x" }], expectedRevision: 1 })).status).toBe(400);

  });

  it("needs the general settings permissions", () => {
    expect(getRoutePermission("/api/v1/admin/settings/emi", "GET")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
    expect(getRoutePermission("/api/v1/admin/settings/emi", "PUT")).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_EDIT });
  });
});
