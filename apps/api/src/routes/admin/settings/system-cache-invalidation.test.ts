import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "../../../utils/api-error";
import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getKv: vi.fn(),
  invalidateSiteSettingsCache: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getEmailProviderReadiness: vi.fn(),
  getEmailRuntimeSettings: vi.fn(),
  readEmailSetting: vi.fn(),
  firstWhatsAppPlaceholderConfigError: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
  saveWhatsAppAccessToken: vi.fn(),
  getSmsProviderReadiness: vi.fn(),
  normalizeFirebaseServiceAccountJson: vi.fn(),
  saveFirebaseServiceAccountJson: vi.fn(),
  getCheckoutReadiness: vi.fn(),
  getCustomerSignInReadiness: vi.fn(),
  getCheckoutFlowSettingsDocument: vi.fn(),
  saveCheckoutFlowSettingsDocument: vi.fn(),
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
  clearNotificationProviderBlocks: vi.fn(),
}));

vi.mock("../../../utils/kv-cache", () => ({
  getKv: mocks.getKv,
}));

vi.mock("@scalius/core/modules/settings", () => ({
  invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
}));

vi.mock("@scalius/core/modules/settings/checkout-readiness", () => ({
  getCheckoutReadiness: mocks.getCheckoutReadiness,
  getCustomerSignInReadiness: mocks.getCustomerSignInReadiness,
  CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE:
    "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.",
}));

vi.mock("@scalius/core/modules/settings/checkout-flow-admin.service", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@scalius/core/modules/settings/checkout-flow-admin.service")
  >();
  return {
    ...actual,
    getCheckoutFlowSettingsDocument: mocks.getCheckoutFlowSettingsDocument,
    saveCheckoutFlowSettingsDocument: mocks.saveCheckoutFlowSettingsDocument,
  };
});

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
  getEmailProviderReadiness: mocks.getEmailProviderReadiness,
  getEmailRuntimeSettings: mocks.getEmailRuntimeSettings,
  readEmailSetting: mocks.readEmailSetting,
}));

vi.mock("@scalius/core/integrations/whatsapp", () => ({
  firstWhatsAppPlaceholderConfigError: mocks.firstWhatsAppPlaceholderConfigError,
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
  saveWhatsAppAccessToken: mocks.saveWhatsAppAccessToken,
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  getSmsProviderReadiness: mocks.getSmsProviderReadiness,
}));

vi.mock("@scalius/core/integrations/firebase/settings", () => ({
  normalizeFirebaseServiceAccountJson: mocks.normalizeFirebaseServiceAccountJson,
  saveFirebaseServiceAccountJson: mocks.saveFirebaseServiceAccountJson,
}));

vi.mock("@scalius/core/modules/notifications/notification-provider-health", () => ({
  clearNotificationProviderBlocks: mocks.clearNotificationProviderBlocks,
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
  mocks.clearNotificationProviderBlocks.mockResolvedValue(undefined);
  mocks.firstWhatsAppPlaceholderConfigError.mockReturnValue(null);
  mocks.getEmailRuntimeSettings.mockResolvedValue({
    provider: "cloudflare",
    sender: "orders@example.com",
    senderConfigured: true,
    resendApiKey: null,
    hasResendApiKey: false,
    cloudflareBindingConfigured: true,
    resendCredentialError: null,
  });
  mocks.getEmailProviderReadiness.mockResolvedValue({
    configured: true,
    provider: "cloudflare",
    sender: "orders@example.com",
    senderConfigured: true,
    cloudflareBindingConfigured: true,
    resendConfigured: false,
    error: null,
    blockers: [],
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
  mocks.getSmsProviderReadiness.mockResolvedValue({
    activeProvider: "bdbulksms",
    configured: true,
    error: null,
  });
  mocks.normalizeFirebaseServiceAccountJson.mockImplementation((value: string) => value.trim());
  mocks.saveFirebaseServiceAccountJson.mockResolvedValue(undefined);
  mocks.getCheckoutReadiness.mockResolvedValue({
    ready: true,
    hasActiveShippingMethod: true,
    hasActiveDeliveryHierarchy: true,
    customerSignInRequired: false,
    hasUsableCustomerSignIn: true,
    issues: [],
  });
  mocks.getCustomerSignInReadiness.mockResolvedValue({
    customerSignInRequired: true,
    hasUsableCustomerSignIn: true,
  });
  mocks.getCheckoutFlowSettingsDocument.mockResolvedValue({
    guestCheckoutEnabled: true,
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
    revision: 1,
  });
  mocks.saveCheckoutFlowSettingsDocument.mockImplementation(async (_db, input) => ({
    guestCheckoutEnabled: input.guestCheckoutEnabled,
    checkoutMode: input.checkoutMode,
    partialPaymentEnabled: input.partialPaymentEnabled,
    partialPaymentAmount: input.partialPaymentAmount,
    revision: input.expectedRevision + 1,
  }));
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

function requestGet(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  executionCtx:
    | { waitUntil: ReturnType<typeof vi.fn>; passThroughOnException: ReturnType<typeof vi.fn> }
    | undefined,
  path: string,
) {
  return app.request(
    `/api/v1/admin/settings${path}`,
    { method: "GET" },
    env,
    executionCtx as never,
  );
}

function requestJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  executionCtx:
    | { waitUntil: ReturnType<typeof vi.fn>; passThroughOnException: ReturnType<typeof vi.fn> }
    | undefined,
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
) {
  return app.request(
    `/api/v1/admin/settings${path}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    executionCtx as never,
  );
}

function checkoutFlowBody(overrides: Record<string, unknown> = {}) {
  return {
    guestCheckoutEnabled: true,
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
    expectedRevision: 1,
    ...overrides,
  };
}

describe("system settings cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates checkout caches after a versioned checkout settings save", async () => {
    const { app, env, executionCtx, kv } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", {
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
      expectedRevision: 1,
    }, "PUT");

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.invalidateSiteSettingsCache).toHaveBeenCalledWith(kv);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("returns the current revision before stale checkout settings can reach provider checks", async () => {
    mocks.getCheckoutFlowSettingsDocument.mockResolvedValueOnce({
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      revision: 2,
    });
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(
      app,
      env,
      executionCtx,
      "/checkout-flow",
      checkoutFlowBody({ guestCheckoutEnabled: false, expectedRevision: 1 }),
      "PUT",
    );

    expect(response.status, await response.clone().text()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "CHECKOUT_FLOW_REVISION_CONFLICT",
        details: { expectedRevision: 1, currentRevision: 2 },
      },
    });
    expect(mocks.getCustomerSignInReadiness).not.toHaveBeenCalled();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.saveCheckoutFlowSettingsDocument).not.toHaveBeenCalled();
  });

  it("returns checkout readiness from the shared checker", async () => {
    mocks.getCheckoutReadiness.mockResolvedValueOnce({
      ready: false,
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: false,
      customerSignInRequired: false,
      hasUsableCustomerSignIn: true,
      issues: ["Add at least one active city with an active zone before checkout can accept orders."],
    });
    const { app, env, executionCtx } = createTestApp();

    const response = await requestGet(app, env, executionCtx, "/checkout-readiness");
    const body = await response.json() as {
      success: boolean;
      data: {
        ready: boolean;
        hasActiveShippingMethod: boolean;
        hasActiveDeliveryHierarchy: boolean;
        customerSignInRequired: boolean;
        hasUsableCustomerSignIn: boolean;
        issues: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        ready: false,
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: false,
      },
    });
    expect(body.data.issues).toEqual([
      "Add at least one active city with an active zone before checkout can accept orders.",
    ]);
  });

  it("rejects SMS customer auth policy before writes when no SMS provider is ready", async () => {
    mocks.getSmsProviderReadiness.mockResolvedValueOnce({
      activeProvider: null,
      configured: false,
      error: "No active SMS provider selected",
    });
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerAuthPolicy: {
        otpChannels: ["sms"],
        requiredContactFields: ["phone"],
        optionalContactFields: [],
        defaultOtpChannel: "sms",
      },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
  });

  it("rejects email customer auth policy before writes when no email provider is ready", async () => {
    mocks.getEmailProviderReadiness.mockResolvedValueOnce({
      configured: false,
      provider: "cloudflare",
      sender: "noreply@example.com",
      senderConfigured: false,
      cloudflareBindingConfigured: false,
      resendConfigured: false,
      error: "Sender email is required before enabling Email OTP.",
      blockers: [
        "Sender email is required before enabling Email OTP.",
        "Configure Cloudflare Email or save a Resend API key before enabling Email OTP.",
      ],
    });
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerAuthPolicy: {
        otpChannels: ["email"],
        requiredContactFields: ["phone"],
        optionalContactFields: [],
        defaultOtpChannel: "email",
      },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
  });

  it("allows email customer auth policy when Cloudflare Email and sender are ready", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerAuthPolicy: {
        otpChannels: ["email"],
        requiredContactFields: ["phone"],
        optionalContactFields: [],
        defaultOtpChannel: "email",
      },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getEmailProviderReadiness).toHaveBeenCalledWith({
      db: expect.anything(),
      env,
      encryptionKey: "credential-key",
    });
    expect(mocks.upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "customer_auth",
      "policy",
      JSON.stringify({
        otpChannels: ["email"],
        requiredContactFields: ["phone"],
        optionalContactFields: [],
        defaultOtpChannel: "email",
      }),
    );
  });

  it("rejects WhatsApp customer auth policy before writes when WhatsApp is not ready", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerAuthPolicy: {
        otpChannels: ["whatsapp"],
        requiredContactFields: ["phone"],
        optionalContactFields: [],
        defaultOtpChannel: "whatsapp",
      },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.saveWhatsAppAccessToken).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("requires the dedicated credential key before saving a real WhatsApp token", async () => {
    const { app, env, executionCtx } = createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    (env as Record<string, unknown>).JWT_SECRET = "jwt-fallback-key";

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerAuthPolicy: {
        otpChannels: ["whatsapp"],
        requiredContactFields: ["phone"],
        optionalContactFields: [],
        defaultOtpChannel: "whatsapp",
      },
      whatsappAccessToken: "EAAG_meta_token",
      whatsappPhoneNumberId: "phone_id_1",
      whatsappTemplateName: "auth_otp",
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.saveWhatsAppAccessToken).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("rejects placeholder WhatsApp provider values before saving auth settings", async () => {
    mocks.firstWhatsAppPlaceholderConfigError.mockReturnValueOnce(
      "WhatsApp access token looks like a placeholder. Save real Meta WhatsApp Cloud API credentials before enabling WhatsApp.",
    );
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      whatsappAccessToken: "dummy",
      whatsappPhoneNumberId: "123456",
      whatsappTemplateName: "test",
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.firstWhatsAppPlaceholderConfigError).toHaveBeenCalledWith([
      ["WhatsApp access token", "dummy"],
      ["WhatsApp phone number ID", "123456"],
      ["WhatsApp template name", "test"],
    ]);
    expect(mocks.saveWhatsAppAccessToken).not.toHaveBeenCalled();
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("rejects partial payment settings when no online gateway is available", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockRejectedValueOnce(
      new ValidationError("Advance payment requires an enabled online payment gateway."),
    );
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("rejects gateway-only checkout mode when no online gateway is available", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockRejectedValueOnce(
      new ValidationError("Online-only checkout requires an enabled online payment gateway."),
    );
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "gateways_only",
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("rejects Fast COD Only when COD is unavailable", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockRejectedValueOnce(
      new ValidationError("COD-only checkout requires Cash on Delivery to be enabled."),
    );
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "guest_cod_only",
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("rejects requiring customer accounts when no sign-in provider is usable", async () => {
    mocks.getCustomerSignInReadiness.mockResolvedValueOnce({
      customerSignInRequired: true,
      hasUsableCustomerSignIn: false,
    });
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(
      app,
      env,
      executionCtx,
      "/checkout-flow",
      checkoutFlowBody({ guestCheckoutEnabled: false }),
      "PUT",
    );

    expect(response.status, await response.clone().text()).toBe(400);
    expect(mocks.saveCheckoutFlowSettingsDocument).not.toHaveBeenCalled();
    expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
  });

  it("rejects legacy checkout fields on the auth settings endpoint", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      checkoutMode: "all",
    });

    expect(response.status, await response.clone().text()).toBe(400);
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
    expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
      expect.anything(),
      { channel: "whatsapp" },
    );
  });

  it("does not pass JWT fallback as the WhatsApp read or migration write key", async () => {
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
      undefined,
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

  it("keeps merchant CSP sources exact and removes inherited platform origins", async () => {
    const { app, env, executionCtx } = createTestApp();
    Object.assign(env, {
      STOREFRONT_URL: "https://storefront.example.com",
      PUBLIC_API_BASE_URL: "https://api.example.com",
      CDN_DOMAIN_URL: "media.example.com",
    });

    const response = await requestJson(app, env, executionCtx, "/security", {
      cspAllowedDomains: [
        "https://storefront.example.com",
        "https://payments.example.com",
        "https://*.widgets.example.com",
      ].join(","),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(env.CACHE.put).toHaveBeenCalledWith(
      "security:csp_allowed_domains",
      "https://payments.example.com,https://*.widgets.example.com",
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
        senderConfigured: true,
        cloudflareBindingConfigured: true,
        resendConfigured: false,
        ready: true,
        readinessError: null,
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
    expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
      expect.anything(),
      { channel: "email" },
    );
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
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
    expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
      expect.anything(),
      { channel: "email" },
    );
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
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
    expect(mocks.clearNotificationProviderBlocks).toHaveBeenCalledWith(
      expect.anything(),
      { channel: "push" },
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
