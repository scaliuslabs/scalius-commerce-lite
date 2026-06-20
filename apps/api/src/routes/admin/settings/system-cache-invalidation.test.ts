import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "../../../utils/api-error";
import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getKv: vi.fn(),
  invalidateSiteSettingsCache: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getEmailRuntimeSettings: vi.fn(),
  readEmailSetting: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
  saveWhatsAppAccessToken: vi.fn(),
  normalizeFirebaseServiceAccountJson: vi.fn(),
  saveFirebaseServiceAccountJson: vi.fn(),
  getOptionalExecutionContext: vi.fn((c: { executionCtx?: ExecutionContext }) => {
    try {
      return c.executionCtx;
    } catch {
      return undefined;
    }
  }),
  getActivePaymentMethods: vi.fn(),
  upsertEncryptedSetting: vi.fn(),
  upsertSetting: vi.fn(),
}));

vi.mock("../../../utils/kv-cache", () => ({
  getKv: mocks.getKv,
}));

vi.mock("@scalius/core/modules/settings", () => ({
  invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
  getOptionalExecutionContext: mocks.getOptionalExecutionContext,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getActivePaymentMethods: mocks.getActivePaymentMethods,
  upsertEncryptedSetting: mocks.upsertEncryptedSetting,
  upsertSetting: mocks.upsertSetting,
}));

vi.mock("@scalius/core/integrations/email", () => ({
  getEmailRuntimeSettings: mocks.getEmailRuntimeSettings,
  readEmailSetting: mocks.readEmailSetting,
}));

vi.mock("@scalius/core/integrations/whatsapp", () => ({
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
  saveWhatsAppAccessToken: mocks.saveWhatsAppAccessToken,
}));

vi.mock("@scalius/core/integrations/firebase/settings", () => ({
  normalizeFirebaseServiceAccountJson: mocks.normalizeFirebaseServiceAccountJson,
  saveFirebaseServiceAccountJson: mocks.saveFirebaseServiceAccountJson,
}));

import { systemSettingsRoutes } from "./system";

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{ id: "site_settings_1" }]),
        where: vi.fn(() => ({
          get: vi.fn(async () => null),
          all: vi.fn(async () => []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => undefined),
      })),
    })),
  };
}

function createTestApp() {
  const kv = { delete: vi.fn() };
  const env = {
    CACHE: {
      id: "api-cache-kv",
      put: vi.fn(async () => undefined),
    },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
  } as unknown as Env;
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.getKv.mockReturnValue(kv);
  mocks.invalidateSiteSettingsCache.mockResolvedValue(undefined);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  mocks.upsertEncryptedSetting.mockResolvedValue(undefined);
  mocks.upsertSetting.mockResolvedValue(undefined);
  mocks.getEmailRuntimeSettings.mockResolvedValue({
    provider: "cloudflare",
    sender: "orders@example.com",
    resendApiKey: null,
    hasResendApiKey: false,
    cloudflareBindingConfigured: true,
  });
  mocks.readEmailSetting.mockResolvedValue("orders@example.com");
  mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
    accessToken: undefined,
    accessTokenConfigured: false,
    phoneNumberId: "",
    authTemplateName: "auth_otp",
    accessTokenSource: "none",
  });
  mocks.saveWhatsAppAccessToken.mockResolvedValue(undefined);
  mocks.normalizeFirebaseServiceAccountJson.mockImplementation((value: string) => value.trim());
  mocks.saveFirebaseServiceAccountJson.mockResolvedValue(undefined);
  mocks.getActivePaymentMethods.mockResolvedValue({
    enabledMethods: ["sslcommerz"],
    defaultMethod: "sslcommerz",
  });

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", createDb() as never);
    await next();
  });
  app.route("/admin/settings", systemSettingsRoutes);

  return { app, env, executionCtx, kv };
}

function requestJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  executionCtx:
    | { waitUntil: ReturnType<typeof vi.fn>; passThroughOnException: ReturnType<typeof vi.fn> }
    | undefined,
  path: string,
  body: unknown,
) {
  return app.request(
    `/api/v1/admin/settings${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    executionCtx as never,
  );
}

describe("system settings cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates checkout caches after auth and checkout settings save", async () => {
    const { app, env, executionCtx, kv } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      authVerificationMethod: "email",
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.invalidateSiteSettingsCache).toHaveBeenCalledWith(kv);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("rejects partial payment settings when no online gateway is available", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("saves a new WhatsApp access token through encrypted credential storage", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      whatsappAccessToken: "EAAG_meta_token",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.saveWhatsAppAccessToken).toHaveBeenCalledWith(
      expect.anything(),
      "EAAG_meta_token",
      "credential-key",
      "site_settings_1",
    );
  });

  it("does not pass JWT fallback as the WhatsApp migration write key", async () => {
    const { app, env, executionCtx } = createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    (env as Record<string, unknown>).JWT_SECRET = "jwt-fallback-key";

    const response = await app.request(
      "/api/v1/admin/settings/auth",
      { method: "GET" },
      env,
      executionCtx as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(
      expect.anything(),
      "jwt-fallback-key",
      {
        migrateLegacy: true,
        migrationEncryptionKey: undefined,
      },
    );
  });

  it("passes the dedicated WhatsApp migration key on auth settings reads", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/auth",
      { method: "GET" },
      env,
      executionCtx as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(
      expect.anything(),
      "credential-key",
      {
        migrateLegacy: true,
        migrationEncryptionKey: "credential-key",
      },
    );
  });

  it("does not resave a masked WhatsApp access token", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      whatsappAccessToken: "••••••••••••",
      whatsappPhoneNumberId: "phone_id_1",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.saveWhatsAppAccessToken).not.toHaveBeenCalled();
  });

  it("invalidates layout caches after CSP security settings save", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/security", {
      cspAllowedDomains: "https://payments.example.com",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["layout"],
      expect.objectContaining({ env }),
    );
  });

  it("does not fail CSP security settings save when ExecutionContext is unavailable", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, undefined, "/security", {
      cspAllowedDomains: "https://payments.example.com",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(env.CACHE.put).toHaveBeenCalledWith(
      "security:csp_allowed_domains",
      "https://payments.example.com",
    );
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["layout"],
      expect.objectContaining({ env }),
    );
  });

  it("returns email provider status without exposing provider secrets", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/email",
      { method: "GET" },
      env,
      executionCtx as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        provider: "cloudflare",
        apiKey: "",
        sender: "orders@example.com",
        cloudflareBindingConfigured: true,
        resendConfigured: false,
      },
    });
  });

  it("saves email provider and sender without resaving a masked Resend key", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/email", {
      provider: "cloudflare",
      sender: "orders@example.com",
      apiKey: "••••••••••••",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "email",
      "email_provider",
      "cloudflare",
    );
    expect(mocks.upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "email",
      "email_sender",
      "orders@example.com",
    );
    expect(mocks.upsertEncryptedSetting).not.toHaveBeenCalled();
  });

  it("encrypts a new Resend key before saving it", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/email", {
      provider: "resend",
      sender: "orders@example.com",
      apiKey: "re_secret_key",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.upsertEncryptedSetting).toHaveBeenCalledWith(
      expect.anything(),
      "email",
      "resend_api_key",
      "re_secret_key",
      "credential-key",
    );
  });

  it("saves a new Firebase service account through encrypted credential storage", async () => {
    const { app, env, executionCtx } = createTestApp();
    const serviceAccount = JSON.stringify({
      client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
      project_id: "scalius-test",
    });

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.normalizeFirebaseServiceAccountJson).toHaveBeenCalledWith(serviceAccount);
    expect(mocks.saveFirebaseServiceAccountJson).toHaveBeenCalledWith(
      expect.anything(),
      serviceAccount,
      "credential-key",
    );
  });

  it("does not resave a masked Firebase service account", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: "••••••••••••",
      publicConfig: { projectId: "scalius-test" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.normalizeFirebaseServiceAccountJson).not.toHaveBeenCalled();
    expect(mocks.saveFirebaseServiceAccountJson).not.toHaveBeenCalled();
  });

  it("fails closed before saving Firebase credentials when CREDENTIAL_ENCRYPTION_KEY is missing", async () => {
    const { app, env, executionCtx } = createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: JSON.stringify({
        client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
        project_id: "scalius-test",
      }),
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(mocks.saveFirebaseServiceAccountJson).not.toHaveBeenCalled();
  });

  it("rejects invalid Firebase service account JSON before saving", async () => {
    const { app, env, executionCtx } = createTestApp();
    mocks.normalizeFirebaseServiceAccountJson.mockImplementationOnce(() => {
      throw new ValidationError("Invalid Service Account JSON");
    });

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: "{not-json",
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.saveFirebaseServiceAccountJson).not.toHaveBeenCalled();
  });
});
