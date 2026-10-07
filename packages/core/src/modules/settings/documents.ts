// src/modules/settings/documents.ts
// Every merchant settings area, declared once. Each document is one `settings`
// row (category = key, key = "document"); see settings-store.ts. Services
// around these documents own domain validation and cross-document rules only.

import { z } from "zod";
import {
  normalizeSupportedCurrencyCode,
  type SupportedCurrencyCode,
} from "@scalius/shared/currency";
import {
  DEFAULT_CUSTOMER_IDENTITY,
  normalizeCustomerIdentitySettings,
  type CustomerIdentitySettings,
} from "@scalius/shared/customer-auth-policy";
import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import {
  normalizeSeoReturnPolicySettings,
  type SeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";
import { emiSettingsSchema, type EmiSettings } from "@scalius/shared/emi";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import {
  DEFAULT_MARKETING_CONSENT_SETTINGS,
  marketingConsentSettingsSchema,
  type MarketingConsentSettings,
} from "@scalius/shared/customer-marketing";
import {
  normalizeCustomerRequestPolicy,
  type CustomerRequestPolicy,
} from "./customer-request-policy.shared";
import type { Database } from "@scalius/database/client";
import { sql, type SQL } from "drizzle-orm";
import { deps } from "../../cache-deps";
import {
  defineSettingsDocument,
  readSettingsDocumentStrict,
  SETTINGS_DOCUMENT_ROW_KEY,
  type StrictSettingsRead,
} from "../../settings-store";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

const jsonRecord = z.record(z.string(), z.unknown());

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
// Store details: business identity (the one source of the store's name,
// phone, email, address and social profiles on every buyer surface),
// invoice defaults, currency, countries.
// ─────────────────────────────────────────

/** Social profiles a store lists (header, footer, mobile menu). */
export const BUSINESS_SOCIAL_LINKS_MAX = 8;

export interface BusinessSocialLink {
  id: string;
  label: string;
  /** An https URL without credentials. */
  url: string;
  /** Optional icon image (a public media URL). */
  iconUrl?: string;
}

/** Stored links that are not usable (a non-https URL, no id) read as absent. */
const businessSocialLinksSchema = z.array(z.unknown()).catch([]).transform((links) =>
  links.flatMap((value): BusinessSocialLink[] => {
    const link = asRecord(value);
    const id = typeof link.id === "string" ? link.id.trim() : "";
    const url = typeof link.url === "string" ? link.url.trim() : "";
    if (!id || !url) return [];
    const iconUrl = typeof link.iconUrl === "string" && link.iconUrl.trim() ? link.iconUrl.trim() : undefined;
    return [{ id, label: typeof link.label === "string" ? link.label.trim() : "", url, ...(iconUrl ? { iconUrl } : {}) }];
  }).slice(0, BUSINESS_SOCIAL_LINKS_MAX));

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
  socialLinks: BusinessSocialLink[];
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
    socialLinks: businessSocialLinksSchema,
  }) as unknown as z.ZodType<BusinessInfo>,
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
    socialLinks: [],
  },
});

/**
 * The shop currency: the store's reporting currency and, until a market has
 * its own (step 6), the currency every market sells in. The price increment
 * is the backup market's (`markets.price_increment_minor`, MARKETS-DESIGN D4).
 */
export interface CurrencySettings {
  currencyCode: SupportedCurrencyCode;
  currencySymbol: string;
}

const DEFAULT_CURRENCY_SETTINGS: CurrencySettings = {
  currencyCode: "BDT",
  currencySymbol: "৳",
};

/** An unsupported stored code means the whole document falls back to BDT. */
export const currencyDocument = defineSettingsDocument<CurrencySettings>({
  key: "currency",
  schema: z.preprocess(
    (value) => {
      const record = asRecord(value);
      const currencyCode = normalizeSupportedCurrencyCode(record.currencyCode);
      return currencyCode ? { ...record, currencyCode } : DEFAULT_CURRENCY_SETTINGS;
    },
    z.object({
      currencyCode: z.string().transform((code) => code as SupportedCurrencyCode),
      currencySymbol: z.string(),
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

/**
 * Settings → Customer accounts: what checkout collects and which code
 * channels prove a buyer. The one document every identity surface reads.
 */
export type CustomerAuthSettings = CustomerIdentitySettings;

export const customerAuthDocument = defineSettingsDocument<CustomerAuthSettings>({
  key: "customer_auth",
  schema: z.preprocess(
    normalizeCustomerIdentitySettings,
    z.object({
      email: z.enum(["required", "optional", "hidden"]),
      whatsapp: z.enum(["off", "same_as_phone", "separate"]),
      channels: z.array(z.enum(["email", "sms", "whatsapp"])).min(1).max(3),
      phoneOptionalForDigital: z.boolean(),
    }),
  ) as unknown as z.ZodType<CustomerAuthSettings>,
  defaults: { ...DEFAULT_CUSTOMER_IDENTITY, channels: [...DEFAULT_CUSTOMER_IDENTITY.channels] },
});

/**
 * Settings → Customer accounts → Marketing: the checkout consent checkbox
 * (label per language, channels it subscribes; always unchecked, never
 * required) and e-mail double opt-in for storefront subscriptions.
 */
export const marketingConsentDocument = defineSettingsDocument<MarketingConsentSettings>({
  key: "marketing_consent",
  schema: marketingConsentSettingsSchema as unknown as z.ZodType<MarketingConsentSettings>,
  defaults: DEFAULT_MARKETING_CONSENT_SETTINGS,
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
// Reviews (Wave B §2): moderation and review requests. On by default (auto
// moderation, a request 7 days after delivery); an unreadable document hides
// reviews and refuses writes (`readReviewSettings`). Request channels are the
// `review_request` row of the notifications document, like every other buyer
// message; this document only says whether and when to ask.
// ─────────────────────────────────────────

export const REVIEW_MODERATION_MODES = ["auto", "hold"] as const;
export type ReviewModerationMode = (typeof REVIEW_MODERATION_MODES)[number];
export const REVIEW_REQUEST_DELAY_DAYS = { min: 1, max: 60 } as const;
export const REVIEW_BLOCK_WORDS_MAX = 50;
/** Matches `REVIEW_LIMITS.blockWordLength` in `@scalius/shared/reviews`. */
export const REVIEW_BLOCK_WORD_MAX_LENGTH = 40;

export interface ReviewSettings {
  enabled: boolean;
  /** `auto` publishes reviews that pass the content checks; `hold` holds every review. Never by rating. */
  moderation: ReviewModerationMode;
  /** Ask buyers for a review after delivery (the channels are the notifications document's `review_request` row). */
  requestsEnabled: boolean;
  /** Days after delivery before the review request goes out. */
  requestDelayDays: number;
  /** Merchant words that hold a review for moderation (en/bn). */
  blockWords: string[];
}

export const reviewsDocument = defineSettingsDocument<ReviewSettings>({
  key: "reviews",
  schema: z.object({
    enabled: z.boolean(),
    moderation: z.enum(REVIEW_MODERATION_MODES),
    requestsEnabled: z.boolean(),
    requestDelayDays: z.number().int().min(REVIEW_REQUEST_DELAY_DAYS.min).max(REVIEW_REQUEST_DELAY_DAYS.max),
    blockWords: z.array(z.string().trim().min(1).max(REVIEW_BLOCK_WORD_MAX_LENGTH)).max(REVIEW_BLOCK_WORDS_MAX),
  }),
  defaults: {
    enabled: true,
    moderation: "auto",
    requestsEnabled: true,
    requestDelayDays: 7,
    blockWords: [],
  },
});

/** Reviews settings, or a failure the caller must treat as "reviews hidden, writes refused". */
export function readReviewSettings(db: Database): Promise<StrictSettingsRead<ReviewSettings>> {
  return readSettingsDocumentStrict(reviewsDocument, db);
}

/**
 * Whether reviews are on, as one SQL expression (1 or 0) for reads that must
 * not spend a settings round trip (the product page row, the store shape): no
 * stored document means the default (on); a stored one counts only when it is
 * JSON whose `enabled` is not `false`. The strict read above stays the
 * authority for every write.
 */
export function reviewsEnabledSql(): SQL<number> {
  // Inside a public render's dependency scope: the reviews document it reads.
  deps.settings("reviews", SETTINGS_DOCUMENT_ROW_KEY);
  return sql<number>`(SELECT CASE WHEN count(*) = 0 THEN 1 ELSE count(CASE WHEN
      (CASE WHEN json_valid(rs."value") THEN coalesce(json_type(rs."value", '$.enabled'), 'true') END) = 'true'
    THEN 1 END) END
    FROM "settings" rs WHERE rs."key" = 'document' AND rs."category" = 'reviews')`;
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

// ─────────────────────────────────────────
// SEO/discovery policy. The look (logo, announcement, footer words, homepage
// sections) is the storefront theme document, never a settings document.
// ─────────────────────────────────────────

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
// Notification provider credentials (the notifications domain owns the
// channel rules and templates documents).
// ─────────────────────────────────────────

export interface EmailSettings {
  /**
   * "cloudflare", "resend" or an app provider's `<plugin id>:<provider id>`.
   * Empty means "not explicitly chosen"; the provider is then inferred.
   */
  provider: string;
  sender: string;
  resendApiKey: string;
}

export const emailDocument = defineSettingsDocument<EmailSettings>({
  key: "email",
  schema: z.object({
    provider: z.union([z.enum(["", "cloudflare", "resend"]), z.string().refine(isQualifiedProviderId)]),
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

/**
 * The merchant's SMS gateway: an app provider id (`<plugin id>:<provider id>`).
 * A store set up before the Bangladesh gateways moved into the Bangladesh
 * pack may still hold their old id and encrypted keys here; the schema keeps
 * those fields untouched (a loose object) until the pack's activation moves
 * them (apps/api/src/plugins/provider-handoff.ts) and replaces the document.
 */
export interface SmsSettings {
  activeProvider: string;
}

export const smsDocument = defineSettingsDocument<SmsSettings>({
  key: "sms",
  schema: z.looseObject({ activeProvider: z.string() }),
  defaults: { activeProvider: "" },
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
