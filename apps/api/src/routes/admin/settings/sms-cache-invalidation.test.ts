import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveSmsSettings: vi.fn(),
  clearNotificationProviderBlocks: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  SMS_PROVIDER_IDS: ["bdbulksms"],
  getSmsSettings: vi.fn(),
  saveSmsSettings: mocks.saveSmsSettings,
}));

vi.mock("@scalius/core/modules/notifications/notification-provider-health", () => ({
  clearNotificationProviderBlocks: mocks.clearNotificationProviderBlocks,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups:
    mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { smsSettingsRoutes } from "./sms";

describe("SMS settings cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates public checkout readiness after a provider save", async () => {
    const env = {
      CACHE: { id: "api-cache-kv" },
      PURGE_URL: "https://storefront.example.com/api/purge-cache",
      PURGE_TOKEN: "secret-token",
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    const db = { id: "db" };

    mocks.saveSmsSettings.mockResolvedValue(undefined);
    mocks.clearNotificationProviderBlocks.mockResolvedValue(undefined);
    mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);

    app.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    app.route("/admin/settings", smsSettingsRoutes);

    const response = await app.request(
      "/api/v1/admin/settings/sms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProvider: "bdbulksms" }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });
});
