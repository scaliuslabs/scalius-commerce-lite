import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { currencyDocument, customerAuthDocument, emailDocument } from "@scalius/core/modules/settings";

import { ValidationError } from "../../../utils/api-error";
import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({

  getEmailProviderReadiness: vi.fn(),
  getEmailRuntimeSettings: vi.fn(),
  firstWhatsAppPlaceholderConfigError: vi.fn(),
  getWhatsAppCloudApiSettings: vi.fn(),
  getSmsProviderReadiness: vi.fn(),
  normalizeFirebaseServiceAccountJson: vi.fn(),
  getCheckoutReadiness: vi.fn(),
  getCustomerSignInReadiness: vi.fn(),
  getCheckoutFlowSettingsDocument: vi.fn(),
  saveCheckoutFlowSettingsDocument: vi.fn(),
  getActivePaymentMethods: vi.fn(),
  readFirebaseSettings: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/settings")>()),
  getCheckoutReadiness: mocks.getCheckoutReadiness,
  getCustomerSignInReadiness: mocks.getCustomerSignInReadiness,
  CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE: {
    code: "unusable_customer_sign_in",
    message:
      "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.",
  },
  getCheckoutFlowSettingsDocument: mocks.getCheckoutFlowSettingsDocument,
  saveCheckoutFlowSettingsDocument: mocks.saveCheckoutFlowSettingsDocument,
}));

vi.mock("@scalius/core/modules/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments")>()),
  getActivePaymentMethods: mocks.getActivePaymentMethods,
}));

vi.mock("@scalius/core/integrations/email", () => ({
  getEmailProviderReadiness: mocks.getEmailProviderReadiness,
  getEmailRuntimeSettings: mocks.getEmailRuntimeSettings,
}));

vi.mock("@scalius/core/integrations/whatsapp", () => ({
  firstWhatsAppPlaceholderConfigError: mocks.firstWhatsAppPlaceholderConfigError,
  getWhatsAppCloudApiSettings: mocks.getWhatsAppCloudApiSettings,
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  getSmsProviderReadiness: mocks.getSmsProviderReadiness,
}));

vi.mock("@scalius/core/integrations/firebase/settings", () => ({
  normalizeFirebaseServiceAccountJson: mocks.normalizeFirebaseServiceAccountJson,
  readFirebaseSettings: mocks.readFirebaseSettings,
}));

import { systemSettingsRoutes } from "./system";

const CREDENTIAL_KEY = Buffer.alloc(32, 21).toString("base64");

interface TestDatabase {
  db: Database;
  sqlite: DatabaseSync;
  /** Fails the next settings document write. */
  failNextWrite: () => void;
}

function createTestDatabase(): TestDatabase {
  let failNextWrite = false;
  const harness = createSqliteD1Database({
    onQuery: (query) => {
      if (!failNextWrite || !/^(insert into|update) "settings"/i.test(query)) return;
      failNextWrite = false;
      throw new Error("settings write failed");
    },
  });
  return { ...harness, failNextWrite: () => { failNextWrite = true; } };
}

/** The stored document, or null before its first save. */
function stored(database: TestDatabase, category: string): Record<string, unknown> | null {
  const row = database.sqlite.prepare("SELECT value FROM settings WHERE category = ? AND key = 'document'")
    .get(category) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Record<string, unknown> : null;
}

function providerBlocks(database: TestDatabase): string[] {
  return (database.sqlite.prepare(
    "SELECT key FROM settings WHERE category = 'notification_provider_health' ORDER BY key",
  ).all() as Array<{ key: string }>).map((row) => row.key);
}

async function createTestApp(setup?: (database: TestDatabase) => Promise<void> | void) {
  const kv = {
    id: "api-cache-kv",
    delete: vi.fn(),
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  };
  const env = {
    CACHE: kv,
    CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY,
  } as unknown as Env;
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.readFirebaseSettings.mockResolvedValue({
    serviceAccountStored: false,
    serviceAccountJson: undefined,
    publicConfig: {},
  });
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
  // The email save handler judges the settings a save would leave behind by
  // handing them to this same reader, so the fake honours an explicit
  // `settings` override instead of always answering "ready".
  mocks.getEmailProviderReadiness.mockImplementation(async (context?: {
    settings?: {
      provider: string;
      sender: string;
      senderConfigured: boolean;
      hasResendApiKey: boolean;
      cloudflareBindingConfigured: boolean;
      localMailpitUrl?: string | null;
    };
  }) => {
    const settings = context?.settings;
    if (!settings) {
      return {
        status: "ready",
        issues: [],
        provider: "cloudflare",
        sender: "orders@example.com",
        senderConfigured: true,
        cloudflareBindingConfigured: true,
        resendConfigured: false,
      };
    }
    const providerConfigured = Boolean(settings.localMailpitUrl)
      || (settings.provider === "resend"
        ? settings.hasResendApiKey
        : settings.cloudflareBindingConfigured);
    const issues = [
      ...(settings.senderConfigured ? [] : [{
        code: "missing_email_sender",
        message: "Sender email is required before enabling email delivery.",
      }]),
      ...(providerConfigured ? [] : [{
        code: "missing_email_provider_credentials",
        message: "The selected email provider is not configured.",
      }]),
    ];
    return {
      status: issues.length === 0 ? "ready" : "incomplete",
      issues,
      provider: settings.provider,
      sender: settings.sender,
      senderConfigured: settings.senderConfigured,
      cloudflareBindingConfigured: settings.cloudflareBindingConfigured,
      resendConfigured: settings.hasResendApiKey,
    };
  });
  mocks.getWhatsAppCloudApiSettings.mockResolvedValue({
    accessToken: undefined,
    accessTokenConfigured: false,
    phoneNumberId: "",
    authTemplateName: "auth_otp",
  });
  mocks.getSmsProviderReadiness.mockResolvedValue({
    status: "ready",
    issues: [],
    activeProvider: "bdbulksms",
  });
  mocks.normalizeFirebaseServiceAccountJson.mockImplementation((value: string) => value.trim());
  mocks.getCheckoutReadiness.mockResolvedValue({
    status: "ready",
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
  const database = createTestDatabase();
  currentDatabase = database;
  await setup?.(database);
  app.use("*", async (c, next) => {
    c.set("db", database.db);
    await next();
  });
  app.route("/admin/settings", systemSettingsRoutes);

  return { app, database, env, executionCtx, kv };
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

let currentDatabase: TestDatabase;

function revisionOf(category: string): number {
  const row = currentDatabase.sqlite.prepare("SELECT revision FROM settings WHERE category = ? AND key = 'document'")
    .get(category) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

/** What the dashboard sends: the revision it loaded, unless a test sets one. */
function withLoadedRevision(path: string, body: unknown): unknown {
  if (!body || typeof body !== "object" || "expectedRevision" in body) return body;
  const expectedRevision = path === "/auth"
    ? { customerAuth: revisionOf("customer_auth"), whatsapp: revisionOf("whatsapp") }
    : ({ "/security": "security", "/email": "email", "/firebase": "firebase" } as Record<string, string>)[path];
  if (expectedRevision === undefined) return body;
  return { ...body, expectedRevision: typeof expectedRevision === "string" ? revisionOf(expectedRevision) : expectedRevision };
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
      body: JSON.stringify(withLoadedRevision(path, body)),
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

describe("system settings write behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns success after a versioned checkout settings save", async () => {
    const { app, env, executionCtx, kv } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", {
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
      expectedRevision: 1,
    }, "PUT");

    expect(response.status, await response.clone().text()).toBe(200);
    expect(kv.delete).not.toHaveBeenCalled();

  });

  it("returns the current revision before stale checkout settings can reach provider checks", async () => {
    mocks.getCheckoutFlowSettingsDocument.mockResolvedValueOnce({
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      revision: 2,
    });
    const { app, env, executionCtx } = await createTestApp();

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
        code: "SETTINGS_REVISION_CONFLICT",
        details: { document: "checkout", expectedRevision: 1, currentRevision: 2 },
      },
    });
    expect(mocks.getCustomerSignInReadiness).not.toHaveBeenCalled();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.saveCheckoutFlowSettingsDocument).not.toHaveBeenCalled();
  });

  it("returns checkout readiness from the shared checker", async () => {
    mocks.getCheckoutReadiness.mockResolvedValueOnce({
      status: "incomplete",
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: false,
      customerSignInRequired: false,
      hasUsableCustomerSignIn: true,
      issues: [{
        code: "missing_active_delivery_location",
        message: "Add at least one active city with an active thana before checkout can accept orders.",
      }],
    });
    const { app, env, executionCtx } = await createTestApp();

    const response = await requestGet(app, env, executionCtx, "/checkout-readiness");
    const body = await response.json() as {
      success: boolean;
      data: {
        status: string;
        hasActiveShippingMethod: boolean;
        hasActiveDeliveryHierarchy: boolean;
        customerSignInRequired: boolean;
        hasUsableCustomerSignIn: boolean;
        issues: Array<{ code: string; message: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        status: "incomplete",
        hasActiveShippingMethod: true,
        hasActiveDeliveryHierarchy: false,
      },
    });
    expect(body.data.issues).toEqual([{
      code: "missing_active_delivery_location",
      message: "Add at least one active city with an active thana before checkout can accept orders.",
    }]);
  });

  it("rejects SMS customer auth policy before writes when no SMS provider is ready", async () => {
    mocks.getSmsProviderReadiness.mockResolvedValueOnce({
      status: "incomplete",
      issues: [{
        code: "missing_sms_provider_credentials",
        message: "No active SMS provider selected",
      }],
      activeProvider: null,
    });
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerIdentity: { email: "optional", whatsapp: "off", channels: ["sms"] },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(stored(database, "customer_auth")).toBeNull();

  });

  it("rejects email customer auth policy before writes when no email provider is ready", async () => {
    mocks.getEmailProviderReadiness.mockResolvedValueOnce({
      status: "incomplete",
      issues: [
        {
          code: "missing_email_sender",
          message: "Sender email is required before enabling Email OTP.",
        },
        {
          code: "missing_email_provider_credentials",
          message: "Configure Cloudflare Email or save a Resend API key before enabling Email OTP.",
        },
      ],
      provider: "cloudflare",
      sender: "noreply@example.com",
      senderConfigured: false,
      cloudflareBindingConfigured: false,
      resendConfigured: false,
    });
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerIdentity: { email: "required", whatsapp: "off", channels: ["email"] },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(stored(database, "customer_auth")).toBeNull();
    expect(stored(database, "whatsapp")).toBeNull();

  });

  it("allows email customer auth policy when Cloudflare Email and sender are ready", async () => {
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerIdentity: { email: "required", whatsapp: "off", channels: ["email"] },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getEmailProviderReadiness).toHaveBeenCalledWith({
      db: expect.anything(),
      env,
      encryptionKey: CREDENTIAL_KEY,
    });
    expect(stored(database, "customer_auth")).toEqual({ email: "required", whatsapp: "off", channels: ["email"] });
  });

  it("rejects WhatsApp customer auth policy before writes when WhatsApp is not ready", async () => {
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerIdentity: { email: "optional", whatsapp: "same_as_phone", channels: ["whatsapp"] },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(stored(database, "customer_auth")).toBeNull();
    expect(stored(database, "whatsapp")).toBeNull();
  });

  it("requires the dedicated credential key before saving a real WhatsApp token", async () => {
    const { app, env, executionCtx, database } = await createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    (env as Record<string, unknown>).JWT_SECRET = "jwt-fallback-key";

    const response = await requestJson(app, env, executionCtx, "/auth", {
      customerIdentity: { email: "optional", whatsapp: "same_as_phone", channels: ["whatsapp"] },
      whatsappAccessToken: "EAAG_meta_token",
      whatsappPhoneNumberId: "phone_id_1",
      whatsappTemplateName: "auth_otp",
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(stored(database, "customer_auth")).toBeNull();
    expect(stored(database, "whatsapp")).toBeNull();
  });

  it("rejects placeholder WhatsApp provider values before saving auth settings", async () => {
    mocks.firstWhatsAppPlaceholderConfigError.mockReturnValueOnce(
      "WhatsApp access token looks like a placeholder. Save real Meta WhatsApp Cloud API credentials before enabling WhatsApp.",
    );
    const { app, env, executionCtx, database } = await createTestApp();

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
    expect(stored(database, "customer_auth")).toBeNull();
    expect(stored(database, "whatsapp")).toBeNull();
  });

  it("rejects partial payment settings when no online gateway is available", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockRejectedValueOnce(
      new ValidationError("Advance payment requires an enabled online payment gateway."),
    );
    const { app, env, executionCtx } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);

  });

  it("rejects gateway-only checkout mode when no online gateway is available", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockRejectedValueOnce(
      new ValidationError("Online-only checkout requires an enabled online payment gateway."),
    );
    const { app, env, executionCtx } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "gateways_only",
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);

  });

  it("treats SSLCommerz as unavailable for checkout-flow validation outside BDT", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockImplementationOnce(async (_db, input) => {
      expect(input.availablePaymentMethods).toEqual([]);
      throw new ValidationError("Online-only checkout requires an enabled online payment gateway.");
    });
    const { app, env, executionCtx } = await createTestApp(({ db }) =>
      currencyDocument.write(db, { currencyCode: "USD" }).then(() => undefined));

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "gateways_only",
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);
  });

  it("rejects Fast COD Only when COD is unavailable", async () => {
    mocks.getActivePaymentMethods.mockResolvedValueOnce({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
    });
    mocks.saveCheckoutFlowSettingsDocument.mockRejectedValueOnce(
      new ValidationError("COD-only checkout requires Cash on Delivery to be enabled."),
    );
    const { app, env, executionCtx } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/checkout-flow", checkoutFlowBody({
      checkoutMode: "guest_cod_only",
    }), "PUT");

    expect(response.status, await response.clone().text()).toBe(400);

  });

  it("rejects requiring customer accounts when no sign-in provider is usable", async () => {
    mocks.getCustomerSignInReadiness.mockResolvedValueOnce({
      customerSignInRequired: true,
      hasUsableCustomerSignIn: false,
    });
    const { app, env, executionCtx } = await createTestApp();

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
  });

  it("rejects legacy checkout fields on the auth settings endpoint", async () => {
    const { app, env, executionCtx } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      checkoutMode: "all",
    });

    expect(response.status, await response.clone().text()).toBe(400);
  });

  it("saves a new WhatsApp access token through encrypted credential storage", async () => {
    const { app, env, executionCtx, database } = await createTestApp(({ sqlite }) => {
      sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
        VALUES ('health', 'whatsapp:whatsapp', '{}', 'json', 'notification_provider_health')`);
    });

    const response = await requestJson(app, env, executionCtx, "/auth", {
      whatsappAccessToken: "EAAG_meta_token",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const whatsapp = stored(database, "whatsapp");
    expect(whatsapp?.accessToken).toMatch(/^enc:/);
    expect(JSON.stringify(whatsapp)).not.toContain("EAAG_meta_token");
    // The provider pause is cleared in the same write.
    expect(providerBlocks(database)).toEqual([]);
  });

  it("rejects clearing WhatsApp credentials while the saved sign-in policy still uses WhatsApp", async () => {
    mocks.getWhatsAppCloudApiSettings.mockResolvedValueOnce({
      accessToken: "existing-meta-token",
      accessTokenConfigured: true,
      phoneNumberId: "phone_id_1",
      authTemplateName: "auth_otp",
    });
    const { app, env, executionCtx, database } = await createTestApp(({ db }) =>
      customerAuthDocument.write(db, { email: "optional", whatsapp: "same_as_phone", channels: ["whatsapp"] }).then(() => undefined));

    const response = await requestJson(app, env, executionCtx, "/auth", {
      whatsappAccessToken: "",
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(stored(database, "whatsapp")).toBeNull();
  });

  it("does not pass the JWT fallback as the WhatsApp read key", async () => {
    const { app, env, executionCtx } = await createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    (env as Record<string, unknown>).JWT_SECRET = "jwt-fallback-key";

    const response = await app.request(
      "/api/v1/admin/settings/auth",
      { method: "GET" },
      env,
      executionCtx as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("passes the dedicated credential key on auth settings reads", async () => {
    const { app, env, executionCtx } = await createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/auth",
      { method: "GET" },
      env,
      executionCtx as never,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getWhatsAppCloudApiSettings).toHaveBeenCalledWith(expect.anything(), CREDENTIAL_KEY);
  });

  it("bounds customer-auth provider identifiers and never returns the WhatsApp secret", async () => {
    mocks.getWhatsAppCloudApiSettings.mockResolvedValueOnce({
      accessToken: "raw-whatsapp-token-must-not-leak",
      accessTokenConfigured: true,
      phoneNumberId: "p".repeat(100_000),
      authTemplateName: "t".repeat(100_000),
    });
    const { app, env, executionCtx } = await createTestApp();

    const response = await requestGet(app, env, executionCtx, "/auth");
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(body.data.whatsappAccessToken).toBe("••••••••••••");
    expect(body.data.whatsappPhoneNumberId).toHaveLength(128);
    expect(body.data.whatsappTemplateName).toHaveLength(128);
    expect(responseText).not.toContain("raw-whatsapp-token-must-not-leak");
  });

  it("does not resave a masked WhatsApp access token", async () => {
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      whatsappAccessToken: "••••••••••••",
      whatsappPhoneNumberId: "phone_id_1",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(stored(database, "customer_auth")).toBeNull();
    expect(stored(database, "whatsapp")).toMatchObject({ accessToken: "", phoneNumberId: "phone_id_1" });
  });

  it("returns success after CSP security settings save", async () => {
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/security", {
      cspAllowedDomains: "https://payments.example.com",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(stored(database, "security")).toEqual({ cspAllowedDomains: "https://payments.example.com" });

  });

  it("refuses, rather than drops, trusted websites it can't use and says what to fix", async () => {
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/security", {
      cspAllowedDomains: "https://payments.example.com,not a url,http://chat.example.com,chat.example.com/widget",
    });
    const body = await response.json() as { error: { details: { issues: Array<{ path: string[]; message: string }> } } };

    expect(response.status).toBe(400);
    expect(body.error.details.issues).toEqual([
      { path: ["cspAllowedDomains"], message: "not a url: Enter a full address like https://chat.example.com." },
      { path: ["cspAllowedDomains"], message: "http://chat.example.com: Use https." },
      { path: ["cspAllowedDomains"], message: "chat.example.com/widget: Enter just the site address, without a path." },
    ]);
    expect(stored(database, "security")).toBeNull();

  });

  it("bounds legacy CSP reads to normalized origins below the agent response ceiling", async () => {
    const storedSources = Array.from(
      { length: 150 },
      (_, index) => `https://asset-${index}.example.com`,
    ).join(",");
    const { app, env, executionCtx } = await createTestApp(({ sqlite }) => {
      sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('csp', 'document', ?, 'json', 'security')")
        .run(JSON.stringify({ cspAllowedDomains: storedSources }));
    });

    const response = await requestGet(app, env, executionCtx, "/security");
    const responseText = await response.text();
    const body = JSON.parse(responseText);
    const sources = body.data.cspAllowedDomains.split(",");

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(sources).toHaveLength(100);
    expect(sources[0]).toBe("https://asset-0.example.com");
    expect(sources[99]).toBe("https://asset-99.example.com");
  });

  it("does not fail CSP security settings save when ExecutionContext is unavailable", async () => {
    const { app, env } = await createTestApp();

    const response = await requestJson(app, env, undefined, "/security", {
      cspAllowedDomains: "https://payments.example.com",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(env.CACHE.put).toHaveBeenCalledWith(
      "settings:security",
      JSON.stringify({ cspAllowedDomains: "https://payments.example.com" }),
    );

  });

  it("keeps merchant CSP sources exact and removes inherited platform origins", async () => {
    const { app, env, executionCtx } = await createTestApp();
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
      "settings:security",
      JSON.stringify({ cspAllowedDomains: "https://payments.example.com,https://*.widgets.example.com" }),
    );
  });

  it("returns normalized inherited runtime trust without caching mutable state", async () => {
    const { app, env, executionCtx } = await createTestApp();
    Object.assign(env, {
      STOREFRONT_URL: "https://storefront.example.com/path",
      PUBLIC_API_BASE_URL: "https://api.example.com",
      BETTER_AUTH_URL: "https://dashboard.example.com",
      CDN_DOMAIN_URL: "media.example.com",
      R2_PUBLIC_URL: "https://r2.example.com/public",
    });

    const response = await requestGet(
      app,
      env,
      executionCtx,
      "/security/runtime-sources",
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [
        expect.objectContaining({ key: "storefront", source: null }),
        expect.objectContaining({ key: "api", source: "https://api.example.com" }),
        expect.objectContaining({ key: "dashboard", source: "https://dashboard.example.com" }),
        expect.objectContaining({ key: "cdn", source: "https://media.example.com" }),
        expect.objectContaining({ key: "r2", source: null }),
      ],
    });
    expect(env.CACHE.put).not.toHaveBeenCalled();
  });

  it("returns email provider status without exposing provider secrets", async () => {
    const { app, env, executionCtx } = await createTestApp(({ db }) =>
      emailDocument.write(db, { provider: "cloudflare", sender: "orders@example.com" }).then(() => undefined));

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
        readiness: { status: "ready", issues: [] },
        revision: 1,
      },
    });
  });

  it("bounds email sender and readiness errors below the operation ceiling", async () => {
    mocks.getEmailProviderReadiness.mockResolvedValueOnce({
      status: "incomplete",
      issues: [{
        code: "missing_email_provider_credentials",
        message: "e".repeat(100_000),
      }],
      provider: "resend",
      sender: "",
      senderConfigured: false,
      cloudflareBindingConfigured: false,
      resendConfigured: true,
    });
    mocks.getEmailRuntimeSettings.mockResolvedValueOnce({
      provider: "resend",
      sender: "",
      senderConfigured: false,
      resendApiKey: "raw-resend-key-must-not-leak",
      hasResendApiKey: true,
      cloudflareBindingConfigured: false,
      resendCredentialError: null,
    });
    const { app, env, executionCtx } = await createTestApp(({ sqlite }) => {
      sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('email', 'document', ?, 'json', 'email')")
        .run(JSON.stringify({ provider: "cloudflare", sender: "s".repeat(100_000), resendApiKey: "" }));
    });

    const response = await requestGet(app, env, executionCtx, "/email");
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(body.data.apiKey).toBe("••••••••••••");
    expect(body.data.sender.length).toBeLessThanOrEqual(320);
    expect(body.data.readiness.issues[0].message).toHaveLength(1_000);
    expect(responseText).not.toContain("raw-resend-key-must-not-leak");
  });

  it("saves email provider and sender without resaving a masked Resend key", async () => {
    const { app, env, executionCtx, database } = await createTestApp(async ({ db, sqlite }) => {
      await emailDocument.write(db, { provider: "resend", resendApiKey: "re_existing" }, { encryptionKey: CREDENTIAL_KEY });
      sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
        VALUES ('health', 'email:resend', '{}', 'json', 'notification_provider_health')`);
    });
    const storedKey = stored(database, "email")?.resendApiKey;

    const response = await requestJson(app, env, executionCtx, "/email", {
      provider: "cloudflare",
      sender: "orders@example.com",
      apiKey: "••••••••••••",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(stored(database, "email")).toEqual({
      provider: "cloudflare",
      sender: "orders@example.com",
      resendApiKey: storedKey,
    });
    expect(providerBlocks(database)).toEqual([]);

  });

  it("encrypts a new Resend key before saving it", async () => {
    const { app, env, executionCtx, database } = await createTestApp();

    const response = await requestJson(app, env, executionCtx, "/email", {
      provider: "resend",
      sender: "orders@example.com",
      apiKey: "re_secret_key",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const email = stored(database, "email");
    expect(email).toMatchObject({ provider: "resend", sender: "orders@example.com" });
    expect(email?.resendApiKey).toMatch(/^enc:/);
    expect(JSON.stringify(email)).not.toContain("re_secret_key");

  });

  it("rejects removing the configured email provider while Email OTP remains enabled", async () => {
    const { app, env, executionCtx, database } = await createTestApp(({ db }) =>
      customerAuthDocument.write(db, { email: "required", whatsapp: "off", channels: ["email"] }).then(() => undefined));

    const response = await requestJson(app, env, executionCtx, "/email", {
      provider: "resend",
      sender: "orders@example.com",
      apiKey: "",
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(stored(database, "email")).toBeNull();

  });

  it("reports failure when the email save fails", async () => {
    const { app, env, executionCtx, database } = await createTestApp();
    database.failNextWrite();

    const response = await requestJson(app, env, executionCtx, "/email", {
      provider: "cloudflare",
      sender: "orders@example.com",
    });

    expect(response.status, await response.clone().text()).toBe(500);

  });

  it("saves Firebase credentials, public config, and push health reset together", async () => {
    const { app, env, executionCtx, database } = await createTestApp(({ sqlite }) => {
      sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
        VALUES ('health', 'push:fcm', '{}', 'json', 'notification_provider_health')`);
    });
    const serviceAccount = JSON.stringify({
      client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
      project_id: "scalius-test",
    });

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount,
      publicConfig: { projectId: "scalius-test" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.normalizeFirebaseServiceAccountJson).toHaveBeenCalledWith(serviceAccount);
    const firebase = stored(database, "firebase");
    expect(firebase?.publicConfig).toEqual({ projectId: "scalius-test" });
    expect(firebase?.serviceAccount).toMatch(/^enc:/);
    expect(JSON.stringify(firebase)).not.toContain("scalius-test\\\\n");
    expect(providerBlocks(database)).toEqual([]);
  });

  it("returns only a configured marker for the Firebase service account", async () => {
    const privateServiceAccount = JSON.stringify({
      client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n",
      project_id: "scalius-test",
    });
    const { app, env, executionCtx } = await createTestApp();
    mocks.readFirebaseSettings.mockResolvedValue({
      serviceAccountStored: true,
      serviceAccountJson: privateServiceAccount,
      publicConfig: { projectId: "scalius-test" },
    });

    const response = await requestGet(app, env, executionCtx, "/firebase");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain("private-material");
    expect(JSON.parse(text)).toMatchObject({
      data: {
        serviceAccount: "••••••••••••",
        publicConfig: { projectId: "scalius-test" },
      },
    });
  });

  it("does not resave a masked Firebase service account", async () => {
    const { app, env, executionCtx, database } = await createTestApp(({ sqlite }) => {
      sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
        VALUES ('firebase', 'document', '{"serviceAccount":"enc:stored","publicConfig":{}}', 'json', 'firebase'),
               ('health', 'push:fcm', '{}', 'json', 'notification_provider_health')`);
    });

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: "••••••••••••",
      publicConfig: { projectId: "scalius-test" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.normalizeFirebaseServiceAccountJson).not.toHaveBeenCalled();
    expect(stored(database, "firebase")).toEqual({
      serviceAccount: "enc:stored",
      publicConfig: { projectId: "scalius-test" },
    });
    expect(providerBlocks(database)).toEqual(["push:fcm"]);
  });

  it("saves an explicit Firebase credential clear without requiring encryption", async () => {
    const { app, env, executionCtx, database } = await createTestApp(({ sqlite }) => {
      sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
        VALUES ('firebase', 'document', '{"serviceAccount":"enc:stored","publicConfig":{"a":1}}', 'json', 'firebase'),
               ('health', 'push:fcm', '{}', 'json', 'notification_provider_health')`);
    });
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: " ", publicConfig: {},
    });

    expect(response.status).toBe(200);
    expect(stored(database, "firebase")).toEqual({ serviceAccount: "", publicConfig: {} });
    expect(providerBlocks(database)).toEqual([]);
  });

  it("preserves omitted Firebase credentials and skips a wholly empty update", async () => {
    const { app, env, executionCtx, database } = await createTestApp();
    expect((await requestJson(app, env, executionCtx, "/firebase", {})).status).toBe(200);
    expect(stored(database, "firebase")).toBeNull();

    expect((await requestJson(app, env, executionCtx, "/firebase", { publicConfig: {} })).status).toBe(200);
    expect(stored(database, "firebase")).toEqual({ serviceAccount: "", publicConfig: {} });
  });

  it.each(["encryption", "write"])("reports Firebase %s failure without separate writes or health cleanup", async (stage) => {
    const { app, env, executionCtx, database } = await createTestApp(({ sqlite }) => {
      sqlite.exec(`INSERT INTO settings (id, key, value, type, category)
        VALUES ('health', 'push:fcm', '{}', 'json', 'notification_provider_health')`);
    });
    if (stage === "encryption") (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY = "not-a-valid-key";
    else database.failNextWrite();

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: JSON.stringify({ client_email: "firebase@example.com", private_key: "test-private-key", project_id: "new-project" }),
      publicConfig: { projectId: "new-project" },
    });
    expect(response.status).toBe(500);
    expect(stored(database, "firebase")).toBeNull();
    expect(providerBlocks(database)).toEqual(["push:fcm"]);
  });

  it("fails closed before saving Firebase credentials when CREDENTIAL_ENCRYPTION_KEY is missing", async () => {
    const { app, env, executionCtx, database } = await createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: JSON.stringify({
        client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
        project_id: "scalius-test",
      }),
      publicConfig: { projectId: "next" },
    });

    expect(response.status, await response.clone().text()).toBe(503);
    expect(stored(database, "firebase")).toBeNull();
  });

  it("rejects invalid Firebase service account JSON before saving", async () => {
    const { app, env, executionCtx, database } = await createTestApp();
    mocks.normalizeFirebaseServiceAccountJson.mockImplementationOnce(() => {
      throw new ValidationError("Invalid Service Account JSON");
    });

    const response = await requestJson(app, env, executionCtx, "/firebase", {
      serviceAccount: "{not-json",
      publicConfig: { projectId: "next" },
    });

    expect(response.status, await response.clone().text()).toBe(400);
    expect(stored(database, "firebase")).toBeNull();
  });
});
