import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  saveSettingAggregate: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/settings-write", () => ({
  saveSettingAggregate: mocks.saveSettingAggregate,
}));
vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { businessSettingsRoutes } from "./business";

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
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

describe("Business email route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveSettingAggregate.mockResolvedValue(undefined);
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects malformed email without constructing an aggregate write", async () => {
    const response = await save(createApp(), { email: "support@" });
    const body = await response.json() as { error?: { message?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.message).toContain("valid business support email address");
    expect(mocks.saveSettingAggregate).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: "  support@example.test  " }, "support@example.test"],
    [{ email: "  " }, ""],
  ] as const)("accepts and normalizes %j", async (body, expectedEmail) => {
    const response = await save(createApp(), body);

    expect(response.status).toBe(200);
    expect(mocks.saveSettingAggregate).toHaveBeenCalledWith(
      expect.anything(),
      [{ category: "business_info", key: "email", value: expectedEmail }],
    );
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledOnce();
  });

  it("leaves omitted email out of the aggregate write", async () => {
    const response = await save(createApp(), { companyName: "Merchant" });

    expect(response.status).toBe(200);
    expect(mocks.saveSettingAggregate).toHaveBeenCalledWith(
      expect.anything(),
      [{ category: "business_info", key: "company_name", value: "Merchant" }],
    );
  });
});
