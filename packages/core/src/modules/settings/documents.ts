// src/modules/settings/documents.ts
// Every merchant settings area, declared once. Each document is one `settings`
// row (category = key, key = "document"); see settings-store.ts. Services
// around these documents own domain validation and cross-document rules only.

import { z } from "zod";
import {
  emptyPlatformConfig,
  normalizePlatformConfig,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  IDENTITY_HANDOFF_CLAIM_MAX_LENGTH,
  type PlatformConfig,
} from "@scalius/shared/platform-config";
import {
  normalizeSupportedCurrencyCode,
  type SupportedCurrencyCode,
} from "@scalius/shared/currency";
import {
  getLegacyCustomerAuthMethodForPolicy,
  normalizeCustomerAuthMethod,
  normalizeCustomerAuthPolicy,
  type CustomerAuthMethod,
  type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  normalizeSeoReturnPolicySettings,
  type SeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";
import {
  sanitizeHomepagePresentationConfig,
  type HomepagePresentationConfig,
} from "@scalius/shared/homepage-presentation";
import { ORDER_NOTIFICATION_TYPES } from "../notifications/notification-types";
import {
  normalizeCustomerRequestPolicy,
  type CustomerRequestPolicy,
} from "./customer-request-policy.shared";
import { defineSettingsDocument } from "./settings-store";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

const jsonRecord = z.record(z.string(), z.unknown());

// ─────────────────────────────────────────
// Platform origins (Settings -> Platform). Read at Worker entry through KV.
// ─────────────────────────────────────────

export const platformDocument = defineSettingsDocument<PlatformConfig>({
  key: "platform",
  schema: z
    .object({
      storefrontUrl: z.string(),
      apiUrl: z.string(),
      dashboardUrl: z.string(),
      mediaUrl: z.string(),
      customerAuthCookieDomain: z.string(),
      // A pre-document comma-separated list is normalized like an array.
      corsAllowedOrigins: z.union([
        z.array(z.string()).max(PLATFORM_CORS_ORIGINS_MAX_COUNT),
        z.string(),
      ]),
      setupTokenRequired: z.boolean(),
      identityHandoff: z.object({
        enabled: z.boolean().default(false),
        issuer: z.string().max(IDENTITY_HANDOFF_CLAIM_MAX_LENGTH).default(""),
        audience: z.string().max(IDENTITY_HANDOFF_CLAIM_MAX_LENGTH).default(""),
        jwksUrl: z.string().default(""),
        localLoginDisabled: z.boolean().default(false),
      }),
    })
    .transform((value) => normalizePlatformConfig(value)),
  defaults: emptyPlatformConfig(),
  cacheKey: "settings:platform",
});

// ─────────────────────────────────────────
// Storefront security policy (merchant CSP sources, comma-separated). The API
// Partytown proxy reads the KV mirror.
// ─────────────────────────────────────────

export interface SecuritySettings {
  cspAllowedDomains: string;
}

export const securityDocument = defineSettingsDocument<SecuritySettings>({
  key: "security",
  schema: z.object({ cspAllowedDomains: z.string() }),
  defaults: { cspAllowedDomains: "" },
  cacheKey: "settings:security",
});

// ─────────────────────────────────────────
// Media delivery hosts: the canonical CDN and older hosts rewritten to it.
// ─────────────────────────────────────────

export const MEDIA_HOST_MAX_LENGTH = 253;
export const MEDIA_HOST_LIST_MAX_COUNT = 24;

export interface MediaOptimizationSettings {
  canonicalCdnUrl: string;
  canonicalHostAliases: string[];
}

export function isValidMediaHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (!host || host.length > MEDIA_HOST_MAX_LENGTH) return false;
  if (host === "localhost") return true;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[a-z0-9-]+$/.test(label);
  });
}

export function normalizeMediaHost(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || /\s/.test(raw)) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    if (parsed.pathname && parsed.pathname !== "/") return "";
    const host = parsed.hostname.toLowerCase();
    return isValidMediaHost(host) ? host : "";
  } catch {
    return "";
  }
}

export const mediaDocument = defineSettingsDocument<MediaOptimizationSettings>({
  key: "media",
  schema: z
    .object({
      canonicalCdnUrl: z.string().max(MEDIA_HOST_MAX_LENGTH),
      canonicalHostAliases: z
        .array(z.string().max(MEDIA_HOST_MAX_LENGTH))
        .max(MEDIA_HOST_LIST_MAX_COUNT),
    })
    .transform((value) => ({
      canonicalCdnUrl: normalizeMediaHost(value.canonicalCdnUrl),
      canonicalHostAliases: [
        ...new Set(value.canonicalHostAliases.map(normalizeMediaHost).filter(Boolean)),
      ],
    })),
  defaults: { canonicalCdnUrl: "", canonicalHostAliases: [] },
});

// ─────────────────────────────────────────
// Store details: business identity, invoice defaults, currency, countries.
// ─────────────────────────────────────────

export interface BusinessInfo {
  companyName: string;
  legalName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  taxId: string;
  invoicePrefix: string;
  invoiceFooterText: string;
  invoiceLogoUrl: string;
}

export const businessDocument = defineSettingsDocument<BusinessInfo>({
  key: "business",
  schema: z.object({
    companyName: z.string(),
    legalName: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string(),
    city: z.string(),
    stateRegion: z.string(),
    postalCode: z.string(),
    country: z.string(),
    phone: z.string(),
    email: z.string(),
    taxId: z.string(),
    invoicePrefix: z.string(),
    invoiceFooterText: z.string(),
    invoiceLogoUrl: z.string(),
  }),
  defaults: {
    companyName: "",
    legalName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    stateRegion: "",
    postalCode: "",
    country: "Bangladesh",
    phone: "",
    email: "",
    taxId: "",
    invoicePrefix: "INV",
    invoiceFooterText: "",
    invoiceLogoUrl: "",
  },
});

export interface CurrencySettings {
  currencyCode: SupportedCurrencyCode;
  currencySymbol: string;
  usdExchangeRate: string;
}

const DEFAULT_CURRENCY_SETTINGS: CurrencySettings = {
  currencyCode: "BDT",
  currencySymbol: "৳",
  usdExchangeRate: "1",
};

/** An unsupported stored code means the whole document falls back to BDT. */
export const currencyDocument = defineSettingsDocument<CurrencySettings>({
  key: "currency",
  schema: z.preprocess(
    (value) => {
      const record = asRecord(value);
      return normalizeSupportedCurrencyCode(record.currencyCode)
        ? { ...record, currencyCode: normalizeSupportedCurrencyCode(record.currencyCode) }
        : DEFAULT_CURRENCY_SETTINGS;
    },
    z.object({
      currencyCode: z.string().transform((code) => code as SupportedCurrencyCode),
      currencySymbol: z.string(),
      usdExchangeRate: z.string(),
    }),
  ) as unknown as z.ZodType<CurrencySettings>,
  defaults: DEFAULT_CURRENCY_SETTINGS,
});

export interface CustomerCountries {
  allowedCountries: string[];
  allowedCountriesMode: "include" | "exclude";
}

export const customerCountriesDocument = defineSettingsDocument<CustomerCountries>({
  key: "customer_countries",
  schema: z.object({
    allowedCountries: z.array(z.string()).catch([]),
    allowedCountriesMode: z.enum(["include", "exclude"]).catch("include"),
  }),
  defaults: { allowedCountries: [], allowedCountriesMode: "include" },
});

// ─────────────────────────────────────────
// Checkout: flow (CAS revision in the admin editor), customer sign-in, and
// buyer self-service requests. Phone collection is not a setting.
// ─────────────────────────────────────────

export type CheckoutMode = "guest_cod_only" | "gateways_only" | "all";

export interface CheckoutFlowSettings {
  guestCheckoutEnabled: boolean;
  checkoutMode: CheckoutMode;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

export const checkoutDocument = defineSettingsDocument<CheckoutFlowSettings>({
  key: "checkout",
  schema: z.object({
    guestCheckoutEnabled: z.boolean(),
    checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]),
    partialPaymentEnabled: z.boolean(),
    partialPaymentAmount: z.number(),
  }),
  defaults: {
    guestCheckoutEnabled: true,
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
  },
});

export interface CustomerAuthSettings {
  /** Derived from the policy; kept for the legacy dashboard and OTP queue fields. */
  authVerificationMethod: CustomerAuthMethod;
  policy: CustomerAuthPolicyConfig;
}

/**
 * A stored policy wins; without one, the policy follows the saved method. The
 * normalized pair is what every reader sees.
 */
export const customerAuthDocument = defineSettingsDocument<CustomerAuthSettings>({
  key: "customer_auth",
  schema: z.preprocess(
    (value) => {
      const record = asRecord(value);
      const storedPolicy = record.policy && typeof record.policy === "object" ? record.policy : undefined;
      const policy = normalizeCustomerAuthPolicy(storedPolicy, record.authVerificationMethod);
      return {
        policy,
        authVerificationMethod: storedPolicy
          ? getLegacyCustomerAuthMethodForPolicy(policy)
          : normalizeCustomerAuthMethod(record.authVerificationMethod),
      };
    },
    z.object({ authVerificationMethod: z.string(), policy: jsonRecord }),
  ) as unknown as z.ZodType<CustomerAuthSettings>,
  defaults: {
    authVerificationMethod: "email",
    policy: normalizeCustomerAuthPolicy(undefined, "email"),
  },
});

export const customerRequestsDocument = defineSettingsDocument<CustomerRequestPolicy>({
  key: "customer_requests",
  schema: z.preprocess(
    normalizeCustomerRequestPolicy,
    jsonRecord,
  ) as unknown as z.ZodType<CustomerRequestPolicy>,
  defaults: normalizeCustomerRequestPolicy(undefined),
});

// ─────────────────────────────────────────
// Online store presentation: header, footer and homepage are JSON documents
// edited with optimistic revisions; SEO/discovery policy.
// ─────────────────────────────────────────

const SITE_PRESENTATION_KEYS = {
  header: new Set(["topBar", "logo", "favicon", "contact", "social"]),
  footer: new Set(["logo", "tagline", "description", "copyrightText", "social"]),
} as const;

export type SitePresentationSection = keyof typeof SITE_PRESENTATION_KEYS;

/** Navigation is its own versioned authority and never lives in these documents. */
export function stripEmbeddedNavigation(
  section: SitePresentationSection,
  config: JsonRecord,
): JsonRecord {
  const allowedKeys = SITE_PRESENTATION_KEYS[section];
  return Object.fromEntries(Object.entries(config).filter(([key]) => allowedKeys.has(key)));
}

function presentationDocument(section: SitePresentationSection) {
  return defineSettingsDocument<JsonRecord>({
    key: section,
    schema: z.preprocess((value) => stripEmbeddedNavigation(section, asRecord(value)), jsonRecord),
    defaults: {},
  });
}

export const headerDocument = presentationDocument("header");
export const footerDocument = presentationDocument("footer");

export const homepageDocument = defineSettingsDocument<HomepagePresentationConfig>({
  key: "homepage",
  schema: z.preprocess(
    sanitizeHomepagePresentationConfig,
    jsonRecord,
  ) as unknown as z.ZodType<HomepagePresentationConfig>,
  defaults: sanitizeHomepagePresentationConfig(null),
});

export interface SeoSettings {
  siteTitle: string;
  homepageTitle: string;
  homepageMetaDescription: string;
  robotsTxt: string;
  discovery: SeoDiscoverySettings;
  returnPolicy: SeoReturnPolicySettings;
}

export const seoDocument = defineSettingsDocument<SeoSettings>({
  key: "seo",
  schema: z.object({
    siteTitle: z.string(),
    homepageTitle: z.string(),
    homepageMetaDescription: z.string(),
    robotsTxt: z.string(),
    discovery: z.unknown().transform(normalizeSeoDiscoverySettings),
    returnPolicy: z.unknown().transform(normalizeSeoReturnPolicySettings),
  }),
  defaults: {
    siteTitle: "",
    homepageTitle: "",
    homepageMetaDescription: "",
    robotsTxt: "",
    discovery: normalizeSeoDiscoverySettings(undefined),
    returnPolicy: normalizeSeoReturnPolicySettings(undefined),
  },
});

// ─────────────────────────────────────────
// Notifications: customer/staff order rules and provider credentials.
// ─────────────────────────────────────────

const CUSTOMER_NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;
const ADMIN_NOTIFICATION_CHANNELS = ["push"] as const;

export type NotificationChannelRules = Record<string, string[]>;

export const DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS: NotificationChannelRules = Object.fromEntries(
  ORDER_NOTIFICATION_TYPES.map((type) => [type, type === "support_request_submitted" ? [] : ["email"]]),
);

export const DEFAULT_ADMIN_NOTIFICATION_CHANNELS: NotificationChannelRules = Object.fromEntries(
  ORDER_NOTIFICATION_TYPES.map((type) => [
    type,
    type === "order_created" || type === "order_cancelled" || type === "support_request_submitted"
      ? ["push"]
      : [],
  ]),
);

/**
 * Accepts the dashboard's boolean maps (optionally wrapped in `{ channels }`)
 * or canonical string arrays; unknown events and, unless `allowed` is null,
 * unknown channels are dropped.
 */
export function normalizeNotificationChannelRules(
  value: unknown,
  defaults: NotificationChannelRules,
  allowed: readonly string[] | null,
): NotificationChannelRules {
  if (!value || typeof value !== "object") return { ...defaults };
  const root = value as JsonRecord;
  const record = root.channels ? asRecord(root.channels) : root;
  const result: NotificationChannelRules = { ...defaults };
  for (const [event, entry] of Object.entries(record)) {
    if (!(ORDER_NOTIFICATION_TYPES as readonly string[]).includes(event)) continue;
    const channels = Array.isArray(entry)
      ? entry.filter((channel): channel is string => typeof channel === "string")
      : entry && typeof entry === "object"
        ? Object.entries(entry as Record<string, unknown>)
          .filter(([, enabled]) => enabled)
          .map(([channel]) => channel)
        : null;
    if (channels) result[event] = allowed ? channels.filter((channel) => allowed.includes(channel)) : channels;
  }
  return result;
}

export interface NotificationSettings {
  orderChannels: NotificationChannelRules;
  adminChannels: NotificationChannelRules;
  whatsappOrderTemplateName: string;
  whatsappOrderTemplateLanguage: string;
}

export const notificationsDocument = defineSettingsDocument<NotificationSettings>({
  key: "notifications",
  schema: z.object({
    orderChannels: z.unknown().transform((value) => normalizeNotificationChannelRules(
      value,
      DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
      CUSTOMER_NOTIFICATION_CHANNELS,
    )),
    adminChannels: z.unknown().transform((value) => normalizeNotificationChannelRules(
      value,
      DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
      ADMIN_NOTIFICATION_CHANNELS,
    )),
    whatsappOrderTemplateName: z.string(),
    whatsappOrderTemplateLanguage: z.string(),
  }),
  defaults: {
    orderChannels: DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
    adminChannels: DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
    whatsappOrderTemplateName: "order_status_update",
    whatsappOrderTemplateLanguage: "en_US",
  },
});

export interface EmailSettings {
  /** Empty means "not explicitly chosen"; the provider is then inferred. */
  provider: "" | "cloudflare" | "resend";
  sender: string;
  resendApiKey: string;
}

export const emailDocument = defineSettingsDocument<EmailSettings>({
  key: "email",
  schema: z.object({
    provider: z.enum(["", "cloudflare", "resend"]),
    sender: z.string().max(320),
    resendApiKey: z.string().max(512),
  }),
  defaults: { provider: "", sender: "", resendApiKey: "" },
  secretFields: { resendApiKey: "Resend API key" },
});

export interface FirebaseSettings {
  /** Plaintext service account JSON; encrypted at rest. */
  serviceAccount: string;
  publicConfig: JsonRecord;
}

export const firebaseDocument = defineSettingsDocument<FirebaseSettings>({
  key: "firebase",
  schema: z.object({ serviceAccount: z.string(), publicConfig: jsonRecord }),
  defaults: { serviceAccount: "", publicConfig: {} },
  secretFields: { serviceAccount: "Firebase service account" },
});

export interface WhatsAppSettings {
  accessToken: string;
  phoneNumberId: string;
  /** Empty means the default `auth_otp` template. */
  authTemplateName: string;
}

export const whatsappDocument = defineSettingsDocument<WhatsAppSettings>({
  key: "whatsapp",
  schema: z.object({
    accessToken: z.string().max(8_192),
    phoneNumberId: z.string(),
    authTemplateName: z.string(),
  }),
  defaults: { accessToken: "", phoneNumberId: "", authTemplateName: "" },
  secretFields: { accessToken: "WhatsApp Cloud API access token" },
});

export interface SmsSettings {
  activeProvider: string;
  bdbulksmsToken: string;
  mimsmsUsername: string;
  mimsmsApiKey: string;
  mimsmsSenderName: string;
  smsnetbdApiKey: string;
  smsnetbdSenderId: string;
  gennetApiToken: string;
  gennetBaseUrl: string;
  gennetSid: string;
}

export const smsDocument = defineSettingsDocument<SmsSettings>({
  key: "sms",
  schema: z.object({
    activeProvider: z.string(),
    bdbulksmsToken: z.string(),
    mimsmsUsername: z.string(),
    mimsmsApiKey: z.string(),
    mimsmsSenderName: z.string(),
    smsnetbdApiKey: z.string(),
    smsnetbdSenderId: z.string(),
    gennetApiToken: z.string(),
    gennetBaseUrl: z.string(),
    gennetSid: z.string(),
  }),
  defaults: {
    activeProvider: "",
    bdbulksmsToken: "",
    mimsmsUsername: "",
    mimsmsApiKey: "",
    mimsmsSenderName: "",
    smsnetbdApiKey: "",
    smsnetbdSenderId: "",
    gennetApiToken: "",
    gennetBaseUrl: "",
    gennetSid: "",
  },
  secretFields: {
    bdbulksmsToken: "BDBulkSMS token",
    mimsmsApiKey: "MIM SMS API key",
    smsnetbdApiKey: "SMS.net.bd API key",
    gennetApiToken: "GenNet API token",
  },
});

// ─────────────────────────────────────────
// Payments. Gateways are unusable until their required credentials resolve;
// readers never guess a method from a failed read.
// ─────────────────────────────────────────

export interface StripeSettingsDocument {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  enabled: boolean;
}

export const stripeDocument = defineSettingsDocument<StripeSettingsDocument>({
  key: "stripe",
  schema: z.object({
    secretKey: z.string(),
    publishableKey: z.string(),
    webhookSecret: z.string(),
    enabled: z.boolean(),
  }),
  defaults: { secretKey: "", publishableKey: "", webhookSecret: "", enabled: true },
  secretFields: { secretKey: "Stripe secret key", webhookSecret: "Stripe webhook secret" },
});

export interface SSLCommerzSettingsDocument {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
  enabled: boolean;
}

export const sslcommerzDocument = defineSettingsDocument<SSLCommerzSettingsDocument>({
  key: "sslcommerz",
  schema: z.object({
    storeId: z.string(),
    storePassword: z.string(),
    sandbox: z.boolean(),
    enabled: z.boolean(),
  }),
  defaults: { storeId: "", storePassword: "", sandbox: true, enabled: true },
  secretFields: { storePassword: "SSLCommerz store password" },
});

export interface PaymentMethodsSettings {
  /** `null` until the merchant saves an allowlist (COD is then implied). */
  enabledMethods: string[] | null;
  defaultMethod: string;
}

export const paymentMethodsDocument = defineSettingsDocument<PaymentMethodsSettings>({
  key: "payment_methods",
  schema: z.object({
    enabledMethods: z.array(z.unknown()).nullable().catch([])
      .transform((methods) => methods?.filter((method): method is string => typeof method === "string") ?? null),
    defaultMethod: z.string().catch("cod"),
  }),
  defaults: { enabledMethods: null, defaultMethod: "cod" },
});

// ─────────────────────────────────────────
// Meta Conversions API. The KV circuit marker is cleared on every save.
// ─────────────────────────────────────────

export interface MetaConversionsSettings {
  pixelId: string;
  accessToken: string;
  testEventCode: string;
  isEnabled: boolean;
  logRetentionDays: number;
}

export const metaConversionsDocument = defineSettingsDocument<MetaConversionsSettings>({
  key: "meta_conversions",
  schema: z.object({
    pixelId: z.string(),
    accessToken: z.string(),
    testEventCode: z.string(),
    isEnabled: z.boolean(),
    logRetentionDays: z.number().int(),
  }),
  defaults: { pixelId: "", accessToken: "", testEventCode: "", isEnabled: false, logRetentionDays: 30 },
  secretFields: { accessToken: "Meta Conversions API access token" },
});

/** Every settings document, for batch reads and the data-migration check. */
export const SETTINGS_DOCUMENTS = [
  platformDocument,
  securityDocument,
  mediaDocument,
  businessDocument,
  currencyDocument,
  customerCountriesDocument,
  checkoutDocument,
  customerAuthDocument,
  customerRequestsDocument,
  headerDocument,
  footerDocument,
  homepageDocument,
  seoDocument,
  notificationsDocument,
  emailDocument,
  firebaseDocument,
  whatsappDocument,
  smsDocument,
  stripeDocument,
  sslcommerzDocument,
  paymentMethodsDocument,
  metaConversionsDocument,
] as const;
