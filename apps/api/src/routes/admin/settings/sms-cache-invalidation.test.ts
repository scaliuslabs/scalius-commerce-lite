import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSmsSettings: vi.fn(),
  saveSmsSettings: vi.fn(),
  clearNotificationProviderBlocks: vi.fn(),
  assertAppProviderInstalled: vi.fn(),
}));

vi.mock("@scalius/core/integrations/sms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/integrations/sms")>()),
  getSmsSettings: mocks.getSmsSettings,
  saveSmsSettings: mocks.saveSmsSettings,
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  clearNotificationProviderBlocks: mocks.clearNotificationProviderBlocks,
}));

vi.mock("../../../plugins/providers/app-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/providers/app-providers")>()),
  assertAppProviderInstalled: mocks.assertAppProviderInstalled,
}));

import { smsSettingsRoutes } from "./sms";

const PACK_SMS = "scalius.bangladesh:bdbulksms";

function createApp(db: unknown = { id: "db" }) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/settings", smsSettingsRoutes);
  return app;
}

describe("SMS settings write behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the bounded gateway choice and its readiness, never a key", async () => {
    const env = { CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as unknown as Env;
    mocks.getSmsSettings.mockResolvedValue({
      activeProvider: PACK_SMS,
      activeProviderConfigured: false,
      activeProviderError: "e".repeat(100_000),
      bdbulksmsToken: "raw-token-must-not-leak",
      revision: 3,
    });

    const response = await createApp().request("/api/v1/admin/settings/sms", { method: "GET" }, env);
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(Object.keys(body.data).sort()).toEqual(["activeProvider", "activeProviderConfigured", "activeProviderError", "revision"]);
    expect(responseText).not.toContain("raw-token-must-not-leak");
    expect(body.data.activeProvider).toBe(PACK_SMS);
    expect(body.data.activeProviderError).toHaveLength(1_000);
    expect(body.data.revision).toBe(3);
  });

  it("saves an installed app's gateway, refusing a built-in id and a save without its revision", async () => {
    const env = { CACHE: { id: "api-cache-kv" }, CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as unknown as Env;
    const db = { id: "db" };
    mocks.saveSmsSettings.mockResolvedValue({ revision: 3 });
    mocks.getSmsSettings.mockResolvedValue({ activeProvider: PACK_SMS, activeProviderConfigured: true, activeProviderError: null, revision: 3 });
    mocks.clearNotificationProviderBlocks.mockResolvedValue(undefined);
    const app = createApp(db);
    const post = (body: unknown) => app.request("/api/v1/admin/settings/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, env);

    const response = await post({ activeProvider: PACK_SMS, expectedRevision: 2 });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.assertAppProviderInstalled).toHaveBeenCalledWith(db, "sms", PACK_SMS);
    expect(mocks.saveSmsSettings).toHaveBeenCalledWith(db, { activeProvider: PACK_SMS }, undefined, { expectedRevision: 2 });
    expect((await response.json() as { data: { revision: number } }).data.revision).toBe(3);

    expect((await post({ activeProvider: "bdbulksms", expectedRevision: 3 })).status).toBe(400);
    expect((await post({ activeProvider: PACK_SMS, bdbulksmsToken: "x", expectedRevision: 3 })).status).toBe(400);
    expect((await post({ activeProvider: PACK_SMS })).status).toBe(400);
    expect(mocks.saveSmsSettings).toHaveBeenCalledTimes(1);
  });
});
