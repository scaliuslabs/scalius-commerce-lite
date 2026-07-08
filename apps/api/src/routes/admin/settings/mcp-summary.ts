import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { siteSettings } from "@scalius/database/schema";
import { getBusinessSettings } from "@scalius/core/modules/settings/business-settings.service";
import {
  getAllowedCountries,
  getCurrencySettings,
  getSeoSettings,
  getStorefrontUrlSetting,
} from "@scalius/core/modules/settings/site-settings.service";
import { getCheckoutReadiness } from "@scalius/core/modules/settings/checkout-readiness";
import {
  getCheckoutFlowValidationIssues,
  isCheckoutGatewayUsableForFlow,
} from "@scalius/core/modules/settings/checkout-flow";
import {
  getActivePaymentMethods,
  getPaymentMethodPreferences,
  getPolarCheckoutReadiness,
  getPolarSettings,
  getSSLCommerzCheckoutReadiness,
  getSSLCommerzSettings,
  getStripeCheckoutReadiness,
  getStripeSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import { getEmailProviderReadiness } from "@scalius/core/integrations/email";
import { getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import { getFirebaseServiceAccountReadiness } from "@scalius/core/integrations/firebase/settings";
import { isWhatsAppCloudApiConfigured } from "@scalius/core/modules/settings/settings.service";
import { getDeliveryProviders } from "@scalius/core/modules/delivery/delivery.service";
import {
  getDeliveryProviderReadinessSummary,
  getDeliveryProviderSetupFingerprint,
} from "@scalius/core/modules/delivery/provider-readiness";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";

import { ok } from "../../../utils/api-response";
import { getCredentialEncryptionKey } from "../../../utils/encryption-key";
import { getKv } from "../../../utils/kv-cache";
import { errorResponses, successEnvelope } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const SUMMARY_SOURCE = {
  path: "/api/v1/admin/settings/mcp-summary",
  permission: "settings.general.view",
  version: "admin-settings-summary:v1",
} as const;

const REDACTION_LIMITS = {
  includesCredentials: false,
  includesMaskedSecrets: false,
  includesProviderIdentifiers: false,
  includesBusinessContacts: false,
  includesAnalyticsSnippets: false,
  includesRawLogs: false,
  includesRawCustomCode: false,
  canMutate: false,
} as const;

const gatewaySummarySchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  usable: z.boolean(),
  issueCount: z.number(),
});

const providerSummarySchema = z.object({
  configured: z.boolean(),
  ready: z.boolean(),
  issueCount: z.number(),
});

const mcpSummarySchema = z.object({
  source: z.object({
    path: z.literal(SUMMARY_SOURCE.path),
    permission: z.literal(SUMMARY_SOURCE.permission),
    version: z.literal(SUMMARY_SOURCE.version),
  }),
  store: z.object({
    storefrontUrl: z.string().nullable(),
    storefrontUrlValid: z.boolean(),
    companyNameConfigured: z.boolean(),
    legalNameConfigured: z.boolean(),
    country: z.string().nullable(),
    currency: z.object({
      code: z.string(),
      symbol: z.string(),
    }),
  }),
  checkout: z.object({
    ready: z.boolean(),
    issues: z.array(z.string()),
    hasActiveShippingMethod: z.boolean(),
    hasActiveDeliveryHierarchy: z.boolean(),
    phoneCollectionRequired: z.literal(true),
    guestCheckoutEnabled: z.boolean(),
    checkoutMode: z.string(),
    partialPaymentEnabled: z.boolean(),
    partialPaymentAmount: z.number().nullable(),
    allowedCountriesMode: z.string(),
    allowedCountries: z.array(z.string()),
  }),
  payments: z.object({
    selectedMethods: z.array(z.string()),
    visibleMethods: z.array(z.string()),
    defaultMethod: z.string().nullable(),
    activeDefaultMethod: z.string().nullable(),
    gateways: z.object({
      cod: gatewaySummarySchema,
      stripe: gatewaySummarySchema,
      sslcommerz: gatewaySummarySchema,
      polar: gatewaySummarySchema,
    }),
  }),
  discovery: z.object({
    sitemap: z.object({
      enabled: z.boolean(),
      staticPages: z.boolean(),
      products: z.boolean(),
      categories: z.boolean(),
      collections: z.boolean(),
      pages: z.boolean(),
    }),
    feeds: z.object({
      productCatalogEnabled: z.boolean(),
      includeUnavailableProducts: z.boolean(),
      variantStrategy: z.enum(["products", "variants"]),
    }),
    robots: z.object({
      advertiseSitemap: z.boolean(),
      customRobotsConfigured: z.boolean(),
    }),
    structuredData: z.object({
      organization: z.boolean(),
      websiteSearch: z.boolean(),
      products: z.boolean(),
      productGroups: z.boolean(),
      offerShippingDetails: z.boolean(),
      breadcrumbs: z.boolean(),
      collections: z.boolean(),
    }),
    returnPolicy: z.object({
      enabled: z.boolean(),
      country: z.string().nullable(),
      category: z.string(),
      returnWindowDaysConfigured: z.boolean(),
      policyUrlConfigured: z.boolean(),
    }),
  }),
  providers: z.object({
    email: providerSummarySchema,
    sms: providerSummarySchema,
    whatsapp: providerSummarySchema,
    push: providerSummarySchema,
    delivery: z.object({
      activeCount: z.number(),
      configuredCount: z.number(),
      testedCount: z.number(),
      blockedCount: z.number(),
    }),
  }),
  limits: z.object({
    includesCredentials: z.literal(false),
    includesMaskedSecrets: z.literal(false),
    includesProviderIdentifiers: z.literal(false),
    includesBusinessContacts: z.literal(false),
    includesAnalyticsSnippets: z.literal(false),
    includesRawLogs: z.literal(false),
    includesRawCustomCode: z.literal(false),
    canMutate: z.literal(false),
  }),
});

const getMcpSummaryRoute = createRoute({
  method: "get",
  path: "/mcp-summary",
  tags: ["Admin - Settings"],
  summary: "Get redacted Admin MCP settings readiness summary",
  responses: {
    200: {
      description: "Redacted Admin MCP settings readiness summary",
      content: {
        "application/json": { schema: successEnvelope(mcpSummarySchema) },
      },
    },
    ...errorResponses,
  },
});

function absoluteHttpUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function configuredString(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function issueCountFromReadiness(readiness: {
  missingFields?: unknown[];
  credentialErrors?: unknown[];
  blockedReason?: unknown;
}): number {
  return (
    (Array.isArray(readiness.missingFields) ? readiness.missingFields.length : 0) +
    (Array.isArray(readiness.credentialErrors) ? readiness.credentialErrors.length : 0) +
    (readiness.blockedReason ? 1 : 0)
  );
}

function providerSummary(readiness: {
  configured: boolean;
  error?: unknown;
  blockers?: unknown[];
}): { configured: boolean; ready: boolean; issueCount: number } {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.length : 0;
  return {
    configured: readiness.configured,
    ready: readiness.configured,
    issueCount: blockers || (readiness.error ? 1 : 0),
  };
}

async function safeProviderSummary(
  read: () => Promise<{ configured: boolean; error?: unknown; blockers?: unknown[] }>,
): Promise<{ configured: boolean; ready: boolean; issueCount: number }> {
  try {
    return providerSummary(await read());
  } catch {
    return { configured: false, ready: false, issueCount: 1 };
  }
}

async function buildDeliverySummary(
  db: Database,
  encryptionKey: string | undefined,
): Promise<{
  activeCount: number;
  configuredCount: number;
  testedCount: number;
  blockedCount: number;
}> {
  try {
    const providers = await getDeliveryProviders(db);
    const fingerprintKey = encryptionKey;
    const summaries = await Promise.all(providers.map(async (provider) => {
      const credentialsRead = await readStoredCredentialStrict(
        provider.credentials,
        encryptionKey,
        "Delivery provider credentials",
      );
      const credentials = credentialsRead.error ? null : credentialsRead.value;
      const currentFingerprint = credentials && fingerprintKey
        ? await getDeliveryProviderSetupFingerprint({
            type: provider.type,
            credentials,
            config: provider.config,
          }, fingerprintKey).catch(() => null)
        : null;

      return getDeliveryProviderReadinessSummary({
        type: provider.type,
        credentials,
        config: provider.config,
        isActive: provider.isActive,
        currentFingerprint,
        lastTestAttemptAt: provider.lastTestAttemptAt,
        lastTestSuccessAt: provider.lastTestSuccessAt,
        lastTestFailureAt: provider.lastTestFailureAt,
        lastTestSuccessFingerprint: provider.lastTestSuccessFingerprint,
      });
    }));

    return {
      activeCount: summaries.filter((summary) => summary.active).length,
      configuredCount: summaries.filter((summary) => summary.configured).length,
      testedCount: summaries.filter((summary) => summary.tested).length,
      blockedCount: summaries.filter((summary) => summary.status === "blocked").length,
    };
  } catch {
    return {
      activeCount: 0,
      configuredCount: 0,
      testedCount: 0,
      blockedCount: 0,
    };
  }
}

async function readCheckoutSettings(db: Database) {
  const [row] = await db
    .select({
      guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
      checkoutMode: siteSettings.checkoutMode,
      partialPaymentEnabled: siteSettings.partialPaymentEnabled,
      partialPaymentAmount: siteSettings.partialPaymentAmount,
    })
    .from(siteSettings)
    .limit(1);

  return {
    guestCheckoutEnabled: row?.guestCheckoutEnabled ?? true,
    checkoutMode: row?.checkoutMode ?? "all",
    partialPaymentEnabled: row?.partialPaymentEnabled ?? false,
    partialPaymentAmount: row?.partialPaymentAmount ?? 0,
  };
}

app.openapi(getMcpSummaryRoute, async (c) => {
  const db = c.get("db");
  const env = c.env as Record<string, unknown>;
  const encryptionKey = getCredentialEncryptionKey(env);
  const kv = getKv();

  const [
    business,
    currency,
    storefrontUrlSetting,
    allowedCountries,
    seo,
    checkoutReadiness,
    checkoutSettings,
    paymentPreferences,
    activePaymentMethods,
    stripeSettings,
    sslCommerzSettings,
    polarSettings,
    email,
    sms,
    whatsapp,
    push,
    delivery,
  ] = await Promise.all([
    getBusinessSettings(db),
    getCurrencySettings(db),
    getStorefrontUrlSetting(db),
    getAllowedCountries(db),
    getSeoSettings(db),
    getCheckoutReadiness(db),
    readCheckoutSettings(db),
    getPaymentMethodPreferences(db),
    getActivePaymentMethods(db, kv, encryptionKey, { bypassMemoryCache: true }),
    getStripeSettings(db, kv, encryptionKey, { bypassMemoryCache: true }),
    getSSLCommerzSettings(db, kv, encryptionKey, { bypassMemoryCache: true }),
    getPolarSettings(db, kv, encryptionKey, { bypassMemoryCache: true }),
    safeProviderSummary(() => getEmailProviderReadiness({ db, env, encryptionKey })),
    safeProviderSummary(() => getSmsProviderReadiness(db, encryptionKey)),
    safeProviderSummary(async () => {
      const configured = await isWhatsAppCloudApiConfigured(db, encryptionKey);
      return { configured, error: configured ? null : "not_configured" };
    }),
    safeProviderSummary(() => getFirebaseServiceAccountReadiness(db, encryptionKey, env)),
    buildDeliverySummary(db, encryptionKey),
  ]);

  const storefrontUrl = absoluteHttpUrl(storefrontUrlSetting.storefrontUrl);
  const stripe = getStripeCheckoutReadiness(stripeSettings);
  const sslcommerz = getSSLCommerzCheckoutReadiness(sslCommerzSettings);
  const polar = getPolarCheckoutReadiness(polarSettings);
  const selectedMethods = paymentPreferences.enabledMethods;
  const flowVisibleMethods = activePaymentMethods.enabledMethods.filter((method) =>
    isCheckoutGatewayUsableForFlow({
      gatewayId: method,
      checkoutMode: checkoutSettings.checkoutMode,
      partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
      partialPaymentAmount: checkoutSettings.partialPaymentAmount,
    }),
  );
  const defaultMethod = selectedMethods.includes(paymentPreferences.defaultMethod)
    ? paymentPreferences.defaultMethod
    : (selectedMethods[0] ?? null);
  const activeDefaultMethod = flowVisibleMethods.includes(activePaymentMethods.defaultMethod)
    ? activePaymentMethods.defaultMethod
    : (flowVisibleMethods[0] ?? null);
  const flowIssues = getCheckoutFlowValidationIssues({
    checkoutMode: checkoutSettings.checkoutMode,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
    availablePaymentMethods: activePaymentMethods.enabledMethods,
  });
  const checkoutIssues = [...checkoutReadiness.issues, ...flowIssues];

  return ok(c, {
    source: SUMMARY_SOURCE,
    store: {
      storefrontUrl,
      storefrontUrlValid: storefrontUrl !== null,
      companyNameConfigured: configuredString(business.companyName),
      legalNameConfigured: configuredString(business.legalName),
      country: configuredString(business.country) ? business.country.trim() : null,
      currency: {
        code: currency.currencyCode,
        symbol: currency.currencySymbol,
      },
    },
    checkout: {
      ready: checkoutReadiness.ready && flowIssues.length === 0,
      issues: checkoutIssues.slice(0, 10),
      hasActiveShippingMethod: checkoutReadiness.hasActiveShippingMethod,
      hasActiveDeliveryHierarchy: checkoutReadiness.hasActiveDeliveryHierarchy,
      phoneCollectionRequired: true as const,
      guestCheckoutEnabled: checkoutSettings.guestCheckoutEnabled,
      checkoutMode: checkoutSettings.checkoutMode,
      partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
      partialPaymentAmount: checkoutSettings.partialPaymentEnabled
        ? Number(checkoutSettings.partialPaymentAmount)
        : null,
      allowedCountriesMode: allowedCountries.allowedCountriesMode,
      allowedCountries: allowedCountries.allowedCountries.slice(0, 64),
    },
    payments: {
      selectedMethods,
      visibleMethods: flowVisibleMethods,
      defaultMethod,
      activeDefaultMethod,
      gateways: {
        cod: {
          configured: true,
          enabled: selectedMethods.includes("cod"),
          usable: true,
          issueCount: 0,
        },
        stripe: {
          configured: stripe.configured,
          enabled: stripe.enabled,
          usable: stripe.usable,
          issueCount: issueCountFromReadiness(stripe),
        },
        sslcommerz: {
          configured: sslcommerz.configured,
          enabled: sslcommerz.enabled,
          usable: sslcommerz.usable,
          issueCount: issueCountFromReadiness(sslcommerz),
        },
        polar: {
          configured: polar.configured,
          enabled: polar.enabled,
          usable: polar.usable,
          issueCount: issueCountFromReadiness(polar),
        },
      },
    },
    discovery: {
      sitemap: seo.discovery.sitemap,
      feeds: {
        productCatalogEnabled: seo.discovery.feeds.productCatalogEnabled,
        includeUnavailableProducts: seo.discovery.feeds.includeUnavailableProducts,
        variantStrategy: seo.discovery.feeds.variantStrategy,
      },
      robots: {
        advertiseSitemap: seo.discovery.robots.advertiseSitemap,
        customRobotsConfigured: configuredString(seo.robotsTxt),
      },
      structuredData: seo.discovery.structuredData,
      returnPolicy: {
        enabled: seo.returnPolicy.enabled,
        country: configuredString(seo.returnPolicy.country)
          ? seo.returnPolicy.country
          : null,
        category: seo.returnPolicy.category,
        returnWindowDaysConfigured: seo.returnPolicy.returnWindowDays !== null,
        policyUrlConfigured: configuredString(seo.returnPolicy.policyUrl),
      },
    },
    providers: {
      email,
      sms,
      whatsapp,
      push,
      delivery,
    },
    limits: REDACTION_LIMITS,
  });
});

export { app as mcpSummarySettingsRoutes };
