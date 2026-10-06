// Customers & marketing vocabulary shared by the API, the dashboard, the
// storefront and plugins: marketing consent (channels, states, sources),
// customer tags and the saved-segment definition. The database CHECKs in
// `@scalius/database/schema` (customer-marketing.ts) mirror these lists.
//
// Identity: a subscriber is a customer record (phone is mandatory for
// customer identity in Bangladesh), so a newsletter signup always carries a
// phone and may add an e-mail; there is no separate subscriber identity.

import { phoneOrNull } from "./customer-auth-policy";
import { z } from "zod";
import { sha256Hex } from "./hash";

// ── Consent ────────────────────────────────────────────────────────────────

export const MARKETING_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

/** Stored states. `pending` is e-mail double opt-in only (confirmation sent). */
export const MARKETING_CONSENT_STATES = ["subscribed", "unsubscribed", "pending"] as const;
export type MarketingConsentState = (typeof MARKETING_CONSENT_STATES)[number];

/**
 * What a reader shows for a channel: a stored state that still covers the
 * customer's current address, or `not_subscribed` (never asked, or the
 * consent was given for an address the customer no longer has).
 */
export const MARKETING_CONSENT_STATUSES = ["subscribed", "pending", "unsubscribed", "not_subscribed"] as const;
export type MarketingConsentStatus = (typeof MARKETING_CONSENT_STATUSES)[number];

/** Where a consent change came from. `link`: a signed e-mail/SMS link (confirm or unsubscribe). */
export const MARKETING_CONSENT_SOURCES = [
  "checkout",
  "account",
  "newsletter",
  "admin",
  "import",
  "plugin",
  "link",
] as const;
export type MarketingConsentSource = (typeof MARKETING_CONSENT_SOURCES)[number];

export const MARKETING_CONSENT_ACTORS = ["buyer", "staff", "plugin", "system"] as const;
export type MarketingConsentActor = (typeof MARKETING_CONSENT_ACTORS)[number];

export const MARKETING_CONSENT_NOTE_MAX = 500;
export const MARKETING_CONSENT_TEXT_MAX = 500;
/** A pending double opt-in confirmation link works this long. */
export const MARKETING_OPT_IN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A buyer can ask for another confirmation e-mail after this long. */
export const MARKETING_OPT_IN_RESEND_SECONDS = 10 * 60;

export function isMarketingChannel(value: unknown): value is MarketingChannel {
  return typeof value === "string" && (MARKETING_CHANNELS as readonly string[]).includes(value);
}

/** The normalised address a consent covers: lower-case e-mail, E.164 phone. */
export function marketingConsentContact(channel: MarketingChannel, customer: { email: string | null | undefined; phone: string | null | undefined }): string | null {
  if (channel === "email") {
    const email = customer.email?.trim().toLowerCase();
    return email ? email : null;
  }
  return phoneOrNull(customer.phone);
}

/** The status a reader shows for a stored row against the customer's current address. */
export function marketingConsentStatus(
  row: { state: MarketingConsentState; contact: string } | null | undefined,
  currentContact: string | null,
): MarketingConsentStatus {
  if (!row || !currentContact || row.contact !== currentContact) return "not_subscribed";
  return row.state;
}

/** "a•••@example.com" / "+880 17•••••678": shown to the buyer on link pages. */
export function maskMarketingContact(channel: MarketingChannel, contact: string): string {
  if (channel === "email") {
    const [local = "", domain = ""] = contact.split("@");
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  const digits = contact.replace(/\D/g, "");
  return `${contact.startsWith("+") ? "+" : ""}${digits.slice(0, 5)}•••••${digits.slice(-3)}`;
}

/**
 * The version of a consent text: `<surface>:<first 12 hex of SHA-256(text)>`.
 * Stored with every subscription so the exact wording shown can be proven.
 */
export async function marketingConsentTextVersion(surface: string, text: string): Promise<string> {
  return `${surface}:${(await sha256Hex(text.normalize("NFC"))).slice(0, 12)}`;
}

// ── Consent settings (settings document `marketing_consent`) ───────────────

export const MARKETING_CONSENT_LABEL_MAX = 200;

// Schemas are built inside pure IIFEs: a bundle that only reads this module's
// constants (the dashboard's customer list) leaves them, and zod, out.
const consentLabel = /* @__PURE__ */ (() => z.string().trim().min(1).max(MARKETING_CONSENT_LABEL_MAX))();

export const marketingConsentSettingsSchema = /* @__PURE__ */ (() => z.object({
  /** The checkout checkbox: always unchecked by default and never required. */
  checkout: z.object({
    enabled: z.boolean(),
    /** Channels the one checkbox subscribes (those whose contact the order has). */
    channels: z.array(z.enum(MARKETING_CHANNELS)).min(1).max(3)
      .refine((channels) => new Set(channels).size === channels.length, "Channels must be unique."),
    label: z.object({ en: consentLabel, bn: consentLabel }).strict(),
  }).strict(),
  /** E-mail subscriptions from the storefront wait for a confirmation link. */
  emailDoubleOptIn: z.boolean(),
}).strict())();

export type MarketingConsentSettings = z.infer<typeof marketingConsentSettingsSchema>;

export const DEFAULT_MARKETING_CONSENT_SETTINGS: MarketingConsentSettings = {
  checkout: {
    enabled: true,
    channels: ["email", "sms"],
    label: {
      en: "Send me news and offers",
      bn: "আমাকে নতুন খবর ও অফার পাঠান",
    },
  },
  emailDoubleOptIn: true,
};

/** The label for a storefront language (`bn` or anything else → English). */
export function marketingConsentLabel(settings: MarketingConsentSettings, language: string | null | undefined): string {
  return language?.toLowerCase().startsWith("bn") ? settings.checkout.label.bn : settings.checkout.label.en;
}

// ── Tags ──────────────────────────────────────────────────────────────────

export const CUSTOMER_TAG_MAX_LENGTH = 40;
export const CUSTOMER_TAGS_PER_CUSTOMER_MAX = 50;
/** Tags in one bulk request (each is one bound value). */
export const CUSTOMER_TAGS_PER_REQUEST_MAX = 10;

/**
 * One tag as stored: NFC, trimmed, inner whitespace collapsed to one space,
 * lower-case, no commas (a comma separates tags in inputs and CSV). Null
 * when nothing is left or it is longer than 40 characters.
 */
export function normalizeCustomerTag(input: string): string | null {
  const tag = input.normalize("NFC").replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  // Characters (code points), as the database CHECK counts them.
  if (!tag || [...tag].length > CUSTOMER_TAG_MAX_LENGTH) return null;
  return tag;
}

/** Normalised, de-duplicated tags in first-seen order; invalid entries are reported. */
export function normalizeCustomerTags(inputs: readonly string[]): { tags: string[]; invalid: string[] } {
  const tags: string[] = [];
  const invalid: string[] = [];
  for (const input of inputs) {
    const tag = normalizeCustomerTag(input);
    if (tag === null) invalid.push(input);
    else if (!tags.includes(tag)) tags.push(tag);
  }
  return { tags, invalid };
}

export const customerTagSchema = /* @__PURE__ */ (() => z.string().max(200).transform((value, context) => {
  const tag = normalizeCustomerTag(value);
  if (tag === null) {
    context.addIssue({ code: "custom", message: `A tag is 1 to ${CUSTOMER_TAG_MAX_LENGTH} characters.` });
    return z.NEVER;
  }
  return tag;
}))();

// ── Segments ──────────────────────────────────────────────────────────────

export const CUSTOMER_SEGMENT_DEFINITION_VERSION = 1;
export const CUSTOMER_SEGMENT_CONDITIONS_MAX = 12;
export const CUSTOMER_SEGMENT_VALUES_MAX = 50;
export const CUSTOMER_SEGMENT_DAYS_MAX = 3650;
/** Live counts stop here and read "100,000+" (each count is one bounded query). */
export const CUSTOMER_SEGMENT_COUNT_CAP = 100_000;

const dateKey = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."))();
const days = /* @__PURE__ */ (() => z.number().int().min(1).max(CUSTOMER_SEGMENT_DAYS_MAX))();
const locationId = /* @__PURE__ */ (() => z.string().trim().min(1).max(128))();

/**
 * A date filter: relative (`within_last` / `not_within_last` N days) or
 * absolute (`on_or_after` / `before` a merchant calendar date, Asia/Dhaka).
 * A customer without the date (never ordered) never matches a date filter;
 * "never ordered" is `orders_count` with `max: 0`.
 */
const dateFilter = /* @__PURE__ */ (() => z.discriminatedUnion("op", [
  z.object({ op: z.literal("within_last"), days }).strict(),
  z.object({ op: z.literal("not_within_last"), days }).strict(),
  z.object({ op: z.literal("on_or_after"), date: dateKey }).strict(),
  z.object({ op: z.literal("before"), date: dateKey }).strict(),
]))();

const MONEY_MINOR_MAX = 1_000_000_000_000;

function conditionSchema(money: z.ZodNumber) {
  return z.discriminatedUnion("field", [
    z.object({ field: z.literal("amount_spent"), min: money.optional(), max: money.optional() }).strict(),
    z.object({ field: z.literal("orders_count"), min: z.number().int().min(0).max(1_000_000).optional(), max: z.number().int().min(0).max(1_000_000).optional() }).strict(),
    z.object({ field: z.literal("last_order_date"), filter: dateFilter }).strict(),
    z.object({ field: z.literal("first_order_date"), filter: dateFilter }).strict(),
    z.object({ field: z.literal("customer_since"), filter: dateFilter }).strict(),
    z.object({ field: z.literal("city"), op: z.enum(["in", "not_in"]), ids: z.array(locationId).min(1).max(CUSTOMER_SEGMENT_VALUES_MAX) }).strict(),
    z.object({ field: z.literal("zone"), op: z.enum(["in", "not_in"]), ids: z.array(locationId).min(1).max(CUSTOMER_SEGMENT_VALUES_MAX) }).strict(),
    z.object({ field: z.literal("tags"), op: z.enum(["has_any", "has_all", "has_none"]), tags: z.array(customerTagSchema).min(1).max(CUSTOMER_SEGMENT_VALUES_MAX) }).strict(),
    z.object({ field: z.literal("marketing_consent"), channel: z.enum(MARKETING_CHANNELS), status: z.enum(MARKETING_CONSENT_STATUSES) }).strict(),
    z.object({ field: z.literal("customer_type"), types: z.array(z.enum(["account", "guest", "merchant"])).min(1).max(3) }).strict(),
    z.object({
      field: z.literal("custom_field"),
      definitionId: z.string().trim().min(4).max(68),
      op: z.enum(["equals", "is_set", "is_not_set"]),
      value: z.string().max(500).optional(),
    }).strict(),
  ]).superRefine((condition, context) => {
    if (condition.field === "custom_field" && (condition.op === "equals") !== (condition.value !== undefined)) {
      context.addIssue({ code: "custom", message: "Give a value only for equals." });
    }
    if ((condition.field === "amount_spent" || condition.field === "orders_count")) {
      if (condition.min === undefined && condition.max === undefined) {
        context.addIssue({ code: "custom", message: "Give a minimum, a maximum or both." });
      } else if (condition.min !== undefined && condition.max !== undefined && condition.min > condition.max) {
        context.addIssue({ code: "custom", message: "The minimum is above the maximum." });
      }
    }
  });
}

/** Segment conditions as stored (money in integer minor units). */
export const customerSegmentConditionSchema = /* @__PURE__ */ (() => conditionSchema(z.number().int().min(0).max(MONEY_MINOR_MAX)))();

/**
 * Segment conditions in the HTTP contract: money in decimal major units
 * (converted once at the edge with the store currency, `mapSegmentMoney`).
 */
export const customerSegmentConditionInputSchema = /* @__PURE__ */ (() => conditionSchema(z.number().min(0).max(MONEY_MINOR_MAX)))();

export type CustomerSegmentCondition = z.infer<typeof customerSegmentConditionSchema>;
export type CustomerSegmentField = CustomerSegmentCondition["field"];
export type CustomerSegmentDateFilter = z.infer<typeof dateFilter>;

export const CUSTOMER_SEGMENT_FIELDS = [
  "amount_spent",
  "orders_count",
  "last_order_date",
  "first_order_date",
  "customer_since",
  "city",
  "zone",
  "tags",
  "marketing_consent",
  "customer_type",
  "custom_field",
] as const satisfies readonly CustomerSegmentField[];

function definitionSchema<T extends z.ZodType>(condition: T) {
  return z.object({
    version: z.literal(CUSTOMER_SEGMENT_DEFINITION_VERSION).default(CUSTOMER_SEGMENT_DEFINITION_VERSION),
    /** `all`: every condition (AND); `any`: at least one (OR). */
    match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(condition).min(1).max(CUSTOMER_SEGMENT_CONDITIONS_MAX),
  }).strict();
}

export const customerSegmentDefinitionSchema = /* @__PURE__ */ (() => definitionSchema(customerSegmentConditionSchema))();
/** The definition as the HTTP contract carries it (money in major units). */
export const customerSegmentDefinitionInputSchema = /* @__PURE__ */ (() => definitionSchema(customerSegmentConditionInputSchema))();

export type CustomerSegmentDefinition = z.infer<typeof customerSegmentDefinitionSchema>;
export type CustomerSegmentDefinitionInput = z.infer<typeof customerSegmentDefinitionInputSchema>;

/**
 * The definition with money converted between the stored minor units and
 * the HTTP contract's decimal major units (`amount_spent` only).
 */
export function mapSegmentMoney<T extends CustomerSegmentDefinition | CustomerSegmentDefinitionInput>(
  definition: T,
  convert: (amount: number) => number,
): T {
  return {
    ...definition,
    conditions: definition.conditions.map((condition) => condition.field === "amount_spent"
      ? {
        field: "amount_spent",
        ...(condition.min !== undefined ? { min: convert(condition.min) } : {}),
        ...(condition.max !== undefined ? { max: convert(condition.max) } : {}),
      }
      : condition),
  } as T;
}

/** Stable JSON for storage and comparison (keys in schema order). */
export function canonicalSegmentDefinitionJson(definition: CustomerSegmentDefinition): string {
  return JSON.stringify(customerSegmentDefinitionSchema.parse(definition));
}

// ── Newsletter signup (storefront) ─────────────────────────────────────────

export const NEWSLETTER_HONEYPOT_FIELD = "company_website";

export const newsletterSubscribeSchema = /* @__PURE__ */ (() => z.object({
  phone: z.string().trim().min(6).max(32),
  email: z.string().trim().max(254).optional().transform((value) => (value ? value : undefined)),
  /** Subscribe this number to WhatsApp messages too (the section offers it). */
  whatsapp: z.boolean().optional(),
  /** Storefront language the form was shown in (consent text version). */
  language: z.string().trim().max(16).optional(),
  /** The exact consent text the form showed, for the consent record. */
  consentText: z.string().trim().min(1).max(MARKETING_CONSENT_TEXT_MAX).optional(),
}).strict())();

/** Outcome the storefront shows; never says whether the contact was known. */
export const NEWSLETTER_RESULTS = ["subscribed", "pending", "error", "rate_limited", "invalid"] as const;
