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
import { emiSettingsSchema, type EmiSettings } from "@scalius/shared/emi";
import {
  NOTIFICATION_TYPES,
  TEMPLATED_NOTIFICATION_TYPES,
  adminChannelsForType,
  customerChannelsForType,
  isNotificationType,
  type NotificationType,
} from "../notifications/notification-types";
import {
  TEMPLATE_LIMITS,
  type NotificationTemplateOverrides,
} from "../notifications/notification-templates";
import {
  normalizeCustomerRequestPolicy,
  type CustomerRequestPolicy,
} from "./customer-request-policy.shared";
import type { Database } from "@scalius/database/client";
import {
  defineSettingsDocument,
  readSettingsDocumentStrict,
  type StrictSettingsRead,
} from "./settings-store";

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

/**
 * When digital and gift-card lines are handed over (Wave B §3.3): as soon as
 * payment settles, or only once staff confirmed the order (stores worried
 * about card fraud on keys and codes).
 */
export const AUTO_FULFIL_MODES = ["after_payment", "after_confirmation"] as const;
export type AutoFulfilMode = (typeof AUTO_FULFIL_MODES)[number];

export interface CheckoutFlowSettings {
  guestCheckoutEnabled: boolean;
  checkoutMode: CheckoutMode;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
  autoFulfilMode: AutoFulfilMode;
}

export const checkoutDocument = defineSettingsDocument<CheckoutFlowSettings>({
  key: "checkout",
  schema: z.object({
    guestCheckoutEnabled: z.boolean(),
    checkoutMode: z.enum(["guest_cod_only", "gateways_only", "all"]),
    partialPaymentEnabled: z.boolean(),
    partialPaymentAmount: z.number(),
    autoFulfilMode: z.enum(AUTO_FULFIL_MODES),
  }),
  defaults: {
    guestCheckoutEnabled: true,
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
    autoFulfilMode: "after_payment",
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
// Reviews (Wave B §2): moderation and review requests. Disabled until the
// reviews slice ships; an unreadable document hides reviews and refuses
// writes (`readReviewSettings`).
// ─────────────────────────────────────────

export const REVIEW_MODERATION_MODES = ["auto", "hold"] as const;
export type ReviewModerationMode = (typeof REVIEW_MODERATION_MODES)[number];
export const REVIEW_REQUEST_DELAY_DAYS = { min: 1, max: 60 } as const;
export const REVIEW_BLOCK_WORDS_MAX = 50;
export const REVIEW_BLOCK_WORD_MAX_LENGTH = 60;

export interface ReviewSettings {
  enabled: boolean;
  /** `auto` publishes reviews that pass the content checks; `hold` holds every review. Never by rating. */
  moderation: ReviewModerationMode;
  /** Days after delivery before the review request goes out. */
  requestDelayDays: number;
  requestEmail: boolean;
  requestSms: boolean;
  /** Merchant words that hold a review for moderation (en/bn). */
  blockWords: string[];
}

export const reviewsDocument = defineSettingsDocument<ReviewSettings>({
  key: "reviews",
  schema: z.object({
    enabled: z.boolean(),
    moderation: z.enum(REVIEW_MODERATION_MODES),
    requestDelayDays: z.number().int().min(REVIEW_REQUEST_DELAY_DAYS.min).max(REVIEW_REQUEST_DELAY_DAYS.max),
    requestEmail: z.boolean(),
    requestSms: z.boolean(),
    blockWords: z.array(z.string().trim().min(1).max(REVIEW_BLOCK_WORD_MAX_LENGTH)).max(REVIEW_BLOCK_WORDS_MAX),
  }),
  defaults: {
    enabled: false,
    moderation: "auto",
    requestDelayDays: 7,
    requestEmail: true,
    requestSms: false,
    blockWords: [],
  },
});

/** Reviews settings, or a failure the caller must treat as "reviews hidden, writes refused". */
export function readReviewSettings(db: Database): Promise<StrictSettingsRead<ReviewSettings>> {
  return readSettingsDocumentStrict(reviewsDocument, db);
}

// ─────────────────────────────────────────
// Gift cards (Wave B §4): cards never expire unless the store sets a default.
// ─────────────────────────────────────────

export const GIFT_CARD_DEFAULT_EXPIRY_MONTHS = { min: 1, max: 120 } as const;

export interface GiftCardSettings {
  /** Months until a newly issued card expires; null = never (the default). */
  defaultExpiryMonths: number | null;
}

export const giftCardsDocument = defineSettingsDocument<GiftCardSettings>({
  key: "gift_cards",
  schema: z.object({
    defaultExpiryMonths: z.number().int()
      .min(GIFT_CARD_DEFAULT_EXPIRY_MONTHS.min)
      .max(GIFT_CARD_DEFAULT_EXPIRY_MONTHS.max)
      .nullable(),
  }),
  defaults: { defaultExpiryMonths: null },
});

/** Gift-card settings, or a failure the caller must treat as "gift cards unavailable". */
export function readGiftCardSettings(db: Database): Promise<StrictSettingsRead<GiftCardSettings>> {
  return readSettingsDocumentStrict(giftCardsDocument, db);
}

// ─────────────────────────────────────────
// Store policies (Settings -> Policies): each policy is one of the store's
// own content pages, by page id. Unknown or trashed pages read as unset.
// ─────────────────────────────────────────

export const STORE_POLICY_KINDS = ["refund", "privacy", "terms", "shipping", "contact"] as const;
export type StorePolicyKind = (typeof STORE_POLICY_KINDS)[number];
export type StorePolicies = Record<StorePolicyKind, string | null>;

const policyPageId = z.string().trim().min(1).max(64).nullable().catch(null);

export const policiesDocument = defineSettingsDocument<StorePolicies>({
  key: "policies",
  schema: z.object(Object.fromEntries(STORE_POLICY_KINDS.map((kind) => [kind, policyPageId])) as Record<
    StorePolicyKind,
    typeof policyPageId
  >) as unknown as z.ZodType<StorePolicies>,
  defaults: { refund: null, privacy: null, terms: null, shipping: null, contact: null },
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

// ─────────────────────────────────────────
// EMI plans: the "EMI on card payment, from X/month" line on eligible
// products. Informational only (no checkout EMI until a gateway supports it);
// off by default and shown only once the merchant enters plans. A stored
// document that is not valid reads as off.
// ─────────────────────────────────────────

export const emiDocument = defineSettingsDocument<EmiSettings>({
  key: "emi",
  schema: emiSettingsSchema,
  defaults: { enabled: false, plans: [] },
});

export interface SeoSettings {
  homepageTitle: string;
  homepageMetaDescription: string;
  /** Default og:image for pages without their own: "" or an absolute https URL. */
  socialImage: string;
  discovery: SeoDiscoverySettings;
  returnPolicy: SeoReturnPolicySettings;
}

export const seoDocument = defineSettingsDocument<SeoSettings>({
  key: "seo",
  schema: z.object({
    homepageTitle: z.string(),
    homepageMetaDescription: z.string(),
    socialImage: z.string().max(2048),
    discovery: z.unknown().transform(normalizeSeoDiscoverySettings),
    returnPolicy: z.unknown().transform(normalizeSeoReturnPolicySettings),
  }),
  defaults: {
    homepageTitle: "",
    homepageMetaDescription: "",
    socialImage: "",
    discovery: normalizeSeoDiscoverySettings(undefined),
    returnPolicy: normalizeSeoReturnPolicySettings(undefined),
  },
});

// ─────────────────────────────────────────
// Notifications: customer/staff order rules and provider credentials.
// ─────────────────────────────────────────

export type NotificationChannelRules = Record<string, string[]>;

/**
 * Buyer defaults: email for every buyer message; ready-for-pickup, digital
 * delivery and gift cards also text; review requests are email only (an SMS
 * costs the merchant). Staff alerts never reach the buyer (Wave B §10).
 */
function defaultCustomerChannels(type: NotificationType): string[] {
  if (type === "conversation_message" || type === "review_pending" || type === "digital_keys_exhausted") return [];
  if (type === "order_ready_for_pickup" || type === "order_digital_delivered" || type === "gift_card_issued") {
    return ["email", "sms"];
  }
  return ["email"];
}

/**
 * Staff defaults: push for new and cancelled orders, support requests, buyer
 * messages and reviews waiting for approval; push and email when a licence
 * key pool runs out.
 */
function defaultAdminChannels(type: NotificationType): string[] {
  if (type === "digital_keys_exhausted") return ["push", "email"];
  return type === "order_created"
    || type === "order_cancelled"
    || type === "support_request_submitted"
    || type === "conversation_message"
    || type === "review_pending"
    ? ["push"]
    : [];
}

export const DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS: NotificationChannelRules = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, defaultCustomerChannels(type)]),
);

export const DEFAULT_ADMIN_NOTIFICATION_CHANNELS: NotificationChannelRules = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, defaultAdminChannels(type)]),
);

/** The channels an event may keep: a fixed list, a per-event rule, or anything (null). */
export type NotificationChannelAllowance =
  | readonly string[]
  | ((event: NotificationType) => readonly string[])
  | null;

/** Buyer channels per event (thread replies never use the order WhatsApp template). */
export const CUSTOMER_CHANNEL_ALLOWANCE: NotificationChannelAllowance = customerChannelsForType;
/** Staff channels per event (staff email only for buyer messages). */
export const ADMIN_CHANNEL_ALLOWANCE: NotificationChannelAllowance = adminChannelsForType;

/**
 * Accepts the dashboard's boolean maps (optionally wrapped in `{ channels }`)
 * or canonical string arrays; unknown events and, unless `allowed` is null,
 * channels the event may not use are dropped.
 */
export function normalizeNotificationChannelRules(
  value: unknown,
  defaults: NotificationChannelRules,
  allowed: NotificationChannelAllowance,
): NotificationChannelRules {
  if (!value || typeof value !== "object") return { ...defaults };
  const root = value as JsonRecord;
  const record = root.channels ? asRecord(root.channels) : root;
  const result: NotificationChannelRules = { ...defaults };
  for (const [event, entry] of Object.entries(record)) {
    if (!isNotificationType(event)) continue;
    const channels = Array.isArray(entry)
      ? entry.filter((channel): channel is string => typeof channel === "string")
      : entry && typeof entry === "object"
        ? Object.entries(entry as Record<string, unknown>)
          .filter(([, enabled]) => enabled)
          .map(([channel]) => channel)
        : null;
    if (!channels) continue;
    const permitted = typeof allowed === "function" ? allowed(event) : allowed;
    result[event] = permitted ? channels.filter((channel) => permitted.includes(channel)) : channels;
  }
  return result;
}

export const STAFF_EMAIL_RECIPIENTS_MAX = 10;

export interface NotificationSettings {
  orderChannels: NotificationChannelRules;
  adminChannels: NotificationChannelRules;
  /** Staff who get an email for every new order. */
  staffEmailRecipients: string[];
  whatsappOrderTemplateName: string;
  whatsappOrderTemplateLanguage: string;
}

export const notificationsDocument = defineSettingsDocument<NotificationSettings>({
  key: "notifications",
  schema: z.object({
    orderChannels: z.unknown().transform((value) => normalizeNotificationChannelRules(
      value,
      DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
      CUSTOMER_CHANNEL_ALLOWANCE,
    )),
    adminChannels: z.unknown().transform((value) => normalizeNotificationChannelRules(
      value,
      DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
      ADMIN_CHANNEL_ALLOWANCE,
    )),
    staffEmailRecipients: z.array(z.string().max(254)).max(STAFF_EMAIL_RECIPIENTS_MAX),
    whatsappOrderTemplateName: z.string(),
    whatsappOrderTemplateLanguage: z.string(),
  }),
  defaults: {
    orderChannels: DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
    adminChannels: DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
    staffEmailRecipients: [],
    whatsappOrderTemplateName: "order_status_update",
    whatsappOrderTemplateLanguage: "en_US",
  },
});

/** Customer message copy the merchant changed; a missing event uses the default. */
export const notificationTemplatesDocument = defineSettingsDocument<NotificationTemplateOverrides>({
  key: "notification_templates",
  schema: z.object({
    email: z.partialRecord(z.enum(TEMPLATED_NOTIFICATION_TYPES), z.object({
      subject: z.string().max(TEMPLATE_LIMITS.subject),
      body: z.string().max(TEMPLATE_LIMITS.emailBody),
    })),
    sms: z.partialRecord(z.enum(TEMPLATED_NOTIFICATION_TYPES), z.object({
      body: z.string().max(TEMPLATE_LIMITS.smsBody),
    })),
  }),
  defaults: { email: {}, sms: {} },
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
  policiesDocument,
  headerDocument,
  footerDocument,
  homepageDocument,
  emiDocument,
  seoDocument,
  notificationsDocument,
  notificationTemplatesDocument,
  emailDocument,
  firebaseDocument,
  whatsappDocument,
  smsDocument,
  stripeDocument,
  sslcommerzDocument,
  paymentMethodsDocument,
  metaConversionsDocument,
  reviewsDocument,
  giftCardsDocument,
] as const;
