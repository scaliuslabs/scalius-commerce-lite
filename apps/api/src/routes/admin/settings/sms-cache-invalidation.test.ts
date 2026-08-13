import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmsSettings: vi.fn(),
  saveSmsSettings: vi.fn(),
  clearNotificationProviderBlocks: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  SMS_PROVIDER_IDS: ["bdbulksms"],
  getSmsSettings: mocks.getSmsSettings,
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

  it("returns a bounded SMS projection with secret values replaced by markers", async () => {
    const env = { CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    mocks.getSmsSettings.mockResolvedValue({
      activeProvider: "bdbulksms",
      activeProviderConfigured: false,
      activeProviderError: "e".repeat(100_000),
      bdbulksmsToken: "raw-token-must-not-leak",
      mimsmsUsername: "u".repeat(100_000),
      mimsmsApiKey: "raw-api-key-must-not-leak",
      mimsmsSenderName: "s".repeat(100_000),
      smsnetbdApiKey: "raw-smsnet-key-must-not-leak",
      smsnetbdSenderId: "i".repeat(100_000),
      gennetApiToken: "raw-gennet-token-must-not-leak",
      gennetBaseUrl: `https://${"a".repeat(100_000)}`,
      gennetSid: "g".repeat(100_000),
    });
    app.use("*", async (c, next) => {
      c.set("db", { id: "db" } as never);
      await next();
    });
    app.route("/admin/settings", smsSettingsRoutes);

    const response = await app.request(
      "/api/v1/admin/settings/sms",
      { method: "GET" },
      env,
    );
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(body.data.bdbulksmsToken).toBe("••••••••••••");
    expect(body.data.mimsmsApiKey).toBe("••••••••••••");
    expect(responseText).not.toContain("raw-token-must-not-leak");
    expect(responseText).not.toContain("raw-api-key-must-not-leak");
    expect(body.data.activeProviderError).toHaveLength(1_000);
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
