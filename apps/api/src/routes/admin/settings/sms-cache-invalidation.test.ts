import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmsSettings: vi.fn(),
  saveSmsSettings: vi.fn(),
  clearNotificationProviderBlocks: vi.fn(),

}));

vi.mock("@scalius/core/integrations/sms", () => ({
  SMS_PROVIDER_IDS: ["bdbulksms"],
  getSmsSettings: mocks.getSmsSettings,
  saveSmsSettings: mocks.saveSmsSettings,
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  clearNotificationProviderBlocks: mocks.clearNotificationProviderBlocks,
}));

import { smsSettingsRoutes } from "./sms";

describe("SMS settings write behavior", () => {
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
      revision: 3,
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
    expect(body.data.revision).toBe(3);
  });

  it("returns success after a provider save", async () => {
    const env = {
      CACHE: { id: "api-cache-kv" },
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    const db = { id: "db" };

    mocks.saveSmsSettings.mockResolvedValue({ revision: 3 });
    mocks.getSmsSettings.mockResolvedValue({
      activeProvider: "bdbulksms",
      activeProviderConfigured: true,
      activeProviderError: null,
      bdbulksmsToken: "••••••••••••",
      mimsmsUsername: "",
      mimsmsApiKey: "",
      mimsmsSenderName: "",
      smsnetbdApiKey: "",
      smsnetbdSenderId: "",
      gennetApiToken: "",
      gennetBaseUrl: "",
      gennetSid: "",
      revision: 3,
    });
    mocks.clearNotificationProviderBlocks.mockResolvedValue(undefined);

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
        body: JSON.stringify({ activeProvider: "bdbulksms", expectedRevision: 2 }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.saveSmsSettings).toHaveBeenCalledWith(db, { activeProvider: "bdbulksms" }, "credential-key", { expectedRevision: 2 });
    expect((await response.json() as { data: { revision: number } }).data.revision).toBe(3);

    const withoutRevision = await app.request(
      "/api/v1/admin/settings/sms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProvider: "bdbulksms" }),
      },
      env,
    );
    expect(withoutRevision.status).toBe(400);

  });
});
