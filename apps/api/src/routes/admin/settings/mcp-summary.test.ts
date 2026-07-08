import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS, getRoutePermission } from "@scalius/core/auth/rbac";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCredentialEncryptionKey: vi.fn(),
  getKv: vi.fn(),
  getBusinessSettings: vi.fn(),
  getCurrencySettings: vi.fn(),
  getStorefrontUrlSetting: vi.fn(),
  getAllowedCountries: vi.fn(),
  getSeoSettings: vi.fn(),
  getCheckoutReadiness: vi.fn(),
  getPaymentMethodPreferences: vi.fn(),
  getActivePaymentMethods: vi.fn(),
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
  getStripeCheckoutReadiness: vi.fn(),
  getSSLCommerzCheckoutReadiness: vi.fn(),
  getPolarCheckoutReadiness: vi.fn(),
  getEmailProviderReadiness: vi.fn(),
  getSmsProviderReadiness: vi.fn(),
  getFirebaseServiceAccountReadiness: vi.fn(),
  isWhatsAppCloudApiConfigured: vi.fn(),
  getDeliveryProviders: vi.fn(),
  readStoredCredentialStrict: vi.fn(),
  getDeliveryProviderSetupFingerprint: vi.fn(),
  getDeliveryProviderReadinessSummary: vi.fn(),
}));

vi.mock("../../../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("../../../utils/kv-cache", () => ({
  getKv: mocks.getKv,
}));

vi.mock("@scalius/core/modules/settings/business-settings.service", () => ({
  getBusinessSettings: mocks.getBusinessSettings,
}));

vi.mock("@scalius/core/modules/settings/site-settings.service", () => ({
  getAllowedCountries: mocks.getAllowedCountries,
  getCurrencySettings: mocks.getCurrencySettings,
  getSeoSettings: mocks.getSeoSettings,
  getStorefrontUrlSetting: mocks.getStorefrontUrlSetting,
}));

vi.mock("@scalius/core/modules/settings/checkout-readiness", () => ({
  getCheckoutReadiness: mocks.getCheckoutReadiness,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/payments/gateway-settings")>(
    "@scalius/core/modules/payments/gateway-settings",
  );
  return {
    ...actual,
    getPaymentMethodPreferences: mocks.getPaymentMethodPreferences,
    getActivePaymentMethods: mocks.getActivePaymentMethods,
    getStripeSettings: mocks.getStripeSettings,
    getSSLCommerzSettings: mocks.getSSLCommerzSettings,
    getPolarSettings: mocks.getPolarSettings,
    getStripeCheckoutReadiness: mocks.getStripeCheckoutReadiness,
    getSSLCommerzCheckoutReadiness: mocks.getSSLCommerzCheckoutReadiness,
    getPolarCheckoutReadiness: mocks.getPolarCheckoutReadiness,
  };
});

vi.mock("@scalius/core/integrations/email", () => ({
  getEmailProviderReadiness: mocks.getEmailProviderReadiness,
}));

vi.mock("@scalius/core/integrations/sms", () => ({
  getSmsProviderReadiness: mocks.getSmsProviderReadiness,
}));

vi.mock("@scalius/core/integrations/firebase/settings", () => ({
  getFirebaseServiceAccountReadiness: mocks.getFirebaseServiceAccountReadiness,
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  isWhatsAppCloudApiConfigured: mocks.isWhatsAppCloudApiConfigured,
}));

vi.mock("@scalius/core/modules/delivery/delivery.service", () => ({
  getDeliveryProviders: mocks.getDeliveryProviders,
}));

vi.mock("@scalius/core/modules/delivery/provider-readiness", () => ({
  getDeliveryProviderSetupFingerprint: mocks.getDeliveryProviderSetupFingerprint,
  getDeliveryProviderReadinessSummary: mocks.getDeliveryProviderReadinessSummary,
}));

vi.mock("@scalius/core/utils/credential-encryption", () => ({
  readStoredCredentialStrict: mocks.readStoredCredentialStrict,
}));

import { mcpSummarySettingsRoutes } from "./mcp-summary";

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{
          guestCheckoutEnabled: true,
          checkoutMode: "all",
          partialPaymentEnabled: true,
          partialPaymentAmount: 50,
        }]),
      })),
    })),
  };
}

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
  } as unknown as Env;

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", createDb() as never);
    await next();
  });
  app.route("/", mcpSummarySettingsRoutes);

  return { app, env };
}

async function requestSummary() {
  const { app, env } = createTestApp();
  const response = await app.request(
    "/api/v1/admin/settings/mcp-summary",
    { method: "GET" },
    env,
  );
  return {
    response,
    body: await response.json() as { success: true; data: Record<string, unknown> },
  };
}

describe("Admin MCP settings summary route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
    mocks.getKv.mockReturnValue({ get: vi.fn(), delete: vi.fn() });
    mocks.getBusinessSettings.mockResolvedValue({
      companyName: "Scalius Demo",
      legalName: "Scalius Demo LLC",
      addressLine1: "Secret House",
      addressLine2: "Suite 9",
      city: "Dhaka",
      stateRegion: "Dhaka",
      postalCode: "1207",
      country: "Bangladesh",
      phone: "+8801711111111",
      email: "merchant@example.com",
      taxId: "BIN-SECRET",
      invoicePrefix: "INV",
      invoiceFooterText: "call +8801711111111",
      invoiceLogoUrl: "https://cdn.example.com/logo.png",
    });
    mocks.getCurrencySettings.mockResolvedValue({
      currencyCode: "BDT",
      currencySymbol: "Tk",
      usdExchangeRate: "1",
    });
    mocks.getStorefrontUrlSetting.mockResolvedValue({
      storefrontUrl: "https://shop.example.com?token=must-drop#frag",
    });
    mocks.getAllowedCountries.mockResolvedValue({
      allowedCountries: ["BD"],
      allowedCountriesMode: "include",
    });
    mocks.getSeoSettings.mockResolvedValue({
      siteTitle: "Secret site title",
      homepageTitle: "Secret homepage title",
      homepageMetaDescription: "Secret meta",
      robotsTxt: "<script>fbq('init','1234567890')</script>",
      discovery: {
        sitemap: {
          enabled: true,
          staticPages: true,
          products: true,
          categories: true,
          collections: true,
          pages: true,
        },
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: false,
          variantStrategy: "variants",
          title: "Private feed title",
          description: "Private feed description",
        },
        robots: {
          advertiseSitemap: true,
        },
        structuredData: {
          organization: true,
          websiteSearch: true,
          products: true,
          productGroups: true,
          offerShippingDetails: false,
          breadcrumbs: true,
          collections: true,
        },
      },
      returnPolicy: {
        enabled: true,
        country: "BD",
        category: "finite",
        returnWindowDays: 7,
        returnFees: "customer_responsibility",
        returnMethod: "mail",
        policyUrl: "/returns?contact=merchant@example.com",
      },
    });
    mocks.getCheckoutReadiness.mockResolvedValue({
      ready: true,
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: true,
      issues: [],
    });
    mocks.getPaymentMethodPreferences.mockResolvedValue({
      enabledMethods: ["cod", "sslcommerz"],
      defaultMethod: "sslcommerz",
      hasExplicitEnabledMethods: true,
    });
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["cod", "sslcommerz"],
      defaultMethod: "sslcommerz",
    });
    mocks.getStripeSettings.mockResolvedValue({
      secretKey: "sk_live_secret_fixture",
      publishableKey: "pk_live_secret_fixture",
      webhookSecret: "whsec_secret_fixture",
      enabled: false,
    });
    mocks.getSSLCommerzSettings.mockResolvedValue({
      storeId: "store-id-secret",
      storePassword: "store-password-secret",
      sandbox: false,
      enabled: true,
    });
    mocks.getPolarSettings.mockResolvedValue({
      accessToken: "polar-secret-token",
      webhookSecret: "polar-webhook-secret",
      productId: "polar-product-secret",
      sandbox: false,
      enabled: false,
    });
    mocks.getStripeCheckoutReadiness.mockReturnValue({
      configured: true,
      enabled: false,
      usable: false,
      missingFields: [],
      credentialErrors: [],
    });
    mocks.getSSLCommerzCheckoutReadiness.mockReturnValue({
      configured: true,
      enabled: true,
      usable: true,
      missingFields: [],
      credentialErrors: [],
    });
    mocks.getPolarCheckoutReadiness.mockReturnValue({
      configured: true,
      enabled: false,
      usable: false,
      missingFields: [],
      credentialErrors: [],
    });
    mocks.getEmailProviderReadiness.mockResolvedValue({
      configured: true,
      provider: "resend",
      sender: "merchant@example.com",
      senderConfigured: true,
      cloudflareBindingConfigured: false,
      resendConfigured: true,
      error: null,
      blockers: [],
    });
    mocks.getSmsProviderReadiness.mockResolvedValue({
      activeProvider: "smsnetbd",
      configured: true,
      error: null,
    });
    mocks.isWhatsAppCloudApiConfigured.mockResolvedValue(true);
    mocks.getFirebaseServiceAccountReadiness.mockResolvedValue({
      configured: true,
      error: null,
      source: "settings",
    });
    mocks.getDeliveryProviders.mockResolvedValue([{
      id: "provider-secret-id",
      name: "Private Pathao Account",
      type: "pathao",
      isActive: true,
      credentials: "{\"clientSecret\":\"delivery-secret\"}",
      config: "{\"storeId\":\"store-secret\"}",
      lastTestAttemptAt: 1,
      lastTestSuccessAt: 1,
      lastTestFailureAt: null,
      lastTestSuccessFingerprint: "fingerprint",
    }]);
    mocks.readStoredCredentialStrict.mockResolvedValue({
      value: "{\"clientSecret\":\"delivery-secret\"}",
      error: null,
    });
    mocks.getDeliveryProviderSetupFingerprint.mockResolvedValue("fingerprint");
    mocks.getDeliveryProviderReadinessSummary.mockReturnValue({
      status: "active",
      configured: true,
      tested: true,
      active: true,
      blockers: [],
      activationBlockers: [],
    });
  });

  it("is mapped to settings.general.view for Admin MCP callers", () => {
    expect(getRoutePermission("/api/v1/admin/settings/mcp-summary", "GET"))
      .toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
  });

  it("returns the bounded summary shape with immutable redaction limits", async () => {
    const { response, body } = await requestSummary();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      source: {
        path: "/api/v1/admin/settings/mcp-summary",
        permission: "settings.general.view",
        version: "admin-settings-summary:v1",
      },
      store: {
        storefrontUrl: "https://shop.example.com",
        storefrontUrlValid: true,
        companyNameConfigured: true,
        legalNameConfigured: true,
        country: "Bangladesh",
        currency: { code: "BDT", symbol: "Tk" },
      },
      checkout: {
        ready: true,
        phoneCollectionRequired: true,
        guestCheckoutEnabled: true,
        checkoutMode: "all",
        partialPaymentEnabled: true,
        partialPaymentAmount: 50,
        allowedCountriesMode: "include",
        allowedCountries: ["BD"],
      },
      payments: {
        selectedMethods: ["cod", "sslcommerz"],
        visibleMethods: ["sslcommerz"],
        defaultMethod: "sslcommerz",
        activeDefaultMethod: "sslcommerz",
      },
      providers: {
        delivery: {
          activeCount: 1,
          configuredCount: 1,
          testedCount: 1,
          blockedCount: 0,
        },
      },
    });
    expect(body.data.limits).toEqual({
      includesCredentials: false,
      includesMaskedSecrets: false,
      includesProviderIdentifiers: false,
      includesBusinessContacts: false,
      includesAnalyticsSnippets: false,
      includesRawLogs: false,
      includesRawCustomCode: false,
      canMutate: false,
    });
  });

  it("does not serialize raw credentials, business contacts, snippets, provider identifiers, or mask placeholders", async () => {
    const { body } = await requestSummary();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("sk_live_secret_fixture");
    expect(serialized).not.toContain("store-password-secret");
    expect(serialized).not.toContain("delivery-secret");
    expect(serialized).not.toContain("provider-secret-id");
    expect(serialized).not.toContain("Private Pathao Account");
    expect(serialized).not.toContain("merchant@example.com");
    expect(serialized).not.toContain("+8801711111111");
    expect(serialized).not.toContain("fbq");
    expect(serialized).not.toContain("1234567890");
    expect(serialized).not.toContain("••••");
  });
});
