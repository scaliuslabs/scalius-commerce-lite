// How an app declares the providers it implements (`manifest.providers`):
// what the platform must know before it ever loads the app's code (the
// merchant's settings pages, checkout eligibility, consent, which optional
// operations it may call). Grouped by port:
//
//   providers: {
//     payment: [{
//       id: "bkash", name: "bKash", chargeCurrencies: ["BDT"],
//       operations: ["verifyReturn", "queryPayment", "refund", "refundStatus", "testConnection"],
//     }],
//     courier: [{ id: "redx", name: "RedX", countries: ["BD"], operations: ["testConnection"] }],
//   }
//
// `operations` lists the port's optional operations the implementation has;
// the host calls exactly the required ones plus these, and the load check
// rejects an implementation that disagrees. The parsed manifest keeps one
// flat list (`{ kind, ...descriptor }`), so grants and registrations read the
// same shape for every kind.

import { z } from "zod";
import { providerAmountCodecsSchema } from "./amount";
import { providerCountriesSchema, providerCurrencySchema } from "./common";
import { PROVIDER_KINDS, PROVIDER_OPERATIONS, RENAMED_PROVIDER_KINDS, currentProviderKind, type ProviderKind } from "./kinds";
import { PAYMENT_CAPABILITIES, PAYMENT_CAPABILITY_OPERATIONS, paymentAmountLimitsSchema, type PaymentCapability } from "./payment";
import { courierBookingOptionKeySchema, type CourierBookingOptionValue } from "./courier";
import { MESSAGING_CHANNELS } from "./channels";
import { pluginKeySchema, pluginUrlNameSchema } from "../manifest-patterns";
import { PAYMENT_TERMS_MAX_DAYS } from "../../payment-terms";

/** A URL path segment (`/webhooks/couriers/<plugin id>:<provider id>`): snake_case or kebab-case. */
const providerId = pluginUrlNameSchema();
const title = z.string().trim().min(1).max(80);
const settingKey = pluginKeySchema();
/**
 * The provider's own mark in the plugin package (`assets/pathao.svg`): an SVG
 * or PNG with the app icon's checks, shown beside the provider where the
 * merchant picks it (a pack's providers are different brands).
 */
const providerIcon = z.string().max(128)
  .regex(/^(?!.*\.\.)[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*\.(?:svg|png)$/, "Use a relative lowercase .svg or .png path inside the plugin.");

/**
 * The most providers one app declares. A regional pack bundles a country's
 * integrations in one app (the Bangladesh pack: 4 SMS gateways, 4
 * courier-history checkers, its couriers and a payment gateway), so the limit is sized for
 * that, not for a single-provider app.
 */
export const PLUGIN_PROVIDERS_MAX = 24;

function base<K extends ProviderKind>(kind: K) {
  const optional = PROVIDER_OPERATIONS[kind].optional as readonly string[];
  return {
    id: providerId,
    name: title,
    operations: z.array(z.string().refine((operation) => optional.includes(operation), `Not an optional ${kind} operation.`))
      .max(optional.length)
      .refine((operations) => new Set(operations).size === operations.length, "List each operation once.")
      .default([]),
    /**
     * The app settings this provider needs (keys of the manifest's
     * `settings`). The provider is ready only when each one is set, readable
     * and not an obvious placeholder, so an app with several providers (a
     * regional pack) reports readiness per provider; its fields need not be
     * `required` for the whole app. Left out: the app's required settings only.
     */
    settings: z.array(settingKey).max(40)
      .refine((keys) => new Set(keys).size === keys.length, "List each setting once.")
      .optional(),
    icon: providerIcon.optional(),
    /**
     * The select setting (`sandbox` or `live`) that says whether this provider
     * talks to its test or its live system, shown to the merchant and the
     * storefront's test notice. Left out: the app's `environment` setting. A
     * pack names one per provider (`sslcommerz_environment`).
     */
    environmentSetting: settingKey.optional(),
  };
}

export const paymentProviderDescriptorSchema = z.object({
  ...base("payment"),
  /** The method name buyers see at checkout (default: `name`). */
  checkoutName: title.optional(),
  /**
   * `hosted`: apps redirect the buyer to the provider's hosted page (in-page
   * card forms are built in). `deferred`: nothing is charged at checkout;
   * the order commits unpaid, due in `dueInDays`, and is paid later (an
   * invoice, a purchase order): its payments reach the order as the
   * provider's verified events, or staff record them. Offered to signed-in
   * buyers only, and only when the app's own `checkout.payment_methods`
   * answers `allow` for this buyer: an app that fails or does not answer
   * leaves it hidden. The manifest declares that function.
   */
  flow: z.enum(["hosted", "deferred"]).default("hosted"),
  /** A `deferred` method's terms: the order is due this many days after placement. */
  dueInDays: z.number().int().min(1).max(PAYMENT_TERMS_MAX_DAYS).optional(),
  /** The currencies the provider can charge; checkout offers it in no other. */
  chargeCurrencies: z.union([z.literal("any"), z.array(providerCurrencySchema).min(1).max(50)]),
  /**
   * The shipping countries it serves (default `any`): checkout never offers
   * it for an order delivered elsewhere (pickup and orders that ship nothing
   * have no shipping country).
   */
  countries: providerCountriesSchema.default("any"),
  amountLimits: paymentAmountLimitsSchema.optional(),
  /** Per-currency wire forms (amount.ts); currencies without one are sent as ISO minor units. */
  amountCodecs: providerAmountCodecsSchema.optional(),
  /**
   * A hosted page that posts the merchant reference (`correlationId`) back,
   * unsigned, with a failed or cancelled return names its form field here
   * (SSLCommerz: `tran_id`). The platform then releases the attempt that
   * reference names on such a return without calling the app: the reference
   * selects an attempt the platform created, it never proves a payment. A
   * success return still goes through `verifyReturn`. Left out: every return
   * is authenticated by `verifyReturn`.
   */
  returnCorrelationField: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
  /**
   * What it can do beyond sessions (PAYMENT_CAPABILITIES): `vault` keeps
   * buyers' payment methods and charges them off-session
   * (`chargeSavedMethod`, `deleteSavedMethod`); `manualCapture` authorizes
   * now and captures or voids later (`capture`, `void`). The platform asks a
   * session to keep the method, charges, captures and voids only through a
   * provider that declares the capability with its operations.
   */
  capabilities: z.array(z.enum(PAYMENT_CAPABILITIES)).max(PAYMENT_CAPABILITIES.length)
    .refine((capabilities) => new Set(capabilities).size === capabilities.length, "List each capability once.")
    .optional(),
}).strict().superRefine((descriptor, context) => {
  const has = (operation: string) => descriptor.operations.includes(operation);
  // A capability and its operations come together, both ways.
  const capabilities = new Set(descriptor.capabilities ?? []);
  for (const [capability, operations] of Object.entries(PAYMENT_CAPABILITY_OPERATIONS)) {
    const declared = capabilities.has(capability as PaymentCapability);
    for (const operation of operations) {
      if (declared && !has(operation)) {
        context.addIssue({ code: "custom", path: ["operations"], message: `A payment provider with ${capability} implements ${operation}.` });
      }
      if (!declared && has(operation)) {
        context.addIssue({ code: "custom", path: ["capabilities"], message: `${operation} belongs to the ${capability} capability; declare it.` });
      }
    }
  }
  // A hosted page returns the buyer, and a buyer may ask whether it went through.
  if (descriptor.flow === "hosted" && (!has("verifyReturn") || !has("queryPayment"))) {
    context.addIssue({ code: "custom", path: ["operations"], message: "A hosted payment provider implements verifyReturn and queryPayment." });
  }
  // A deferred method names its terms; any other flow has none.
  if (descriptor.flow === "deferred" && descriptor.dueInDays === undefined) {
    context.addIssue({ code: "custom", path: ["dueInDays"], message: "A deferred payment provider declares dueInDays." });
  }
  if (descriptor.flow !== "deferred" && descriptor.dueInDays !== undefined) {
    context.addIssue({ code: "custom", path: ["dueInDays"], message: "Only a deferred payment provider declares dueInDays." });
  }
  // A refund whose answer was lost must be asked about, never submitted again.
  if (has("refund") && !has("refundStatus")) {
    context.addIssue({ code: "custom", path: ["operations"], message: "A provider that refunds implements refundStatus." });
  }
});

const choiceValue = z.union([z.string().min(1).max(64), z.number().int().min(-1_000_000).max(1_000_000)]);

/**
 * One of a courier's own booking choices (Pathao's delivery type), shown on
 * the booking form: a `select` of fixed choices, a `number` within bounds or
 * a `boolean`. The chosen value reaches `createShipment` and `quote` in
 * `options.<key>`; an option left unset is absent (the courier's default).
 */
export const courierBookingOptionSchema = z.discriminatedUnion("type", [
  z.object({
    key: courierBookingOptionKeySchema, label: title, type: z.literal("select"),
    choices: z.array(z.object({ value: choiceValue, label: title }).strict()).min(1).max(20)
      .refine((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length, "List each value once."),
  }).strict(),
  z.object({
    key: courierBookingOptionKeySchema, label: title, type: z.literal("number"),
    min: z.number().finite().optional(), max: z.number().finite().optional(),
  }).strict(),
  z.object({ key: courierBookingOptionKeySchema, label: title, type: z.literal("boolean") }).strict(),
]);
export type CourierBookingOption = z.output<typeof courierBookingOptionSchema>;

/**
 * Staff choices kept to the options a courier declares: unknown keys, and
 * values that are not one of a select's choices, a number within bounds or a
 * boolean, are dropped (the courier then uses its own default).
 */
export function declaredCourierBookingOptions(
  declared: readonly CourierBookingOption[] | undefined,
  chosen: Readonly<Record<string, unknown>> | undefined,
): Record<string, CourierBookingOptionValue> {
  const options: Record<string, CourierBookingOptionValue> = {};
  for (const option of declared ?? []) {
    const value = chosen?.[option.key];
    if (value === undefined || value === null) continue;
    if (option.type === "select" && option.choices.some((choice) => choice.value === value)) options[option.key] = value as string | number;
    if (option.type === "number" && typeof value === "number" && Number.isFinite(value)
      && (option.min === undefined || value >= option.min) && (option.max === undefined || value <= option.max)) options[option.key] = value;
    if (option.type === "boolean" && typeof value === "boolean") options[option.key] = value;
  }
  return options;
}

export const courierProviderDescriptorSchema = z.object({
  ...base("courier"),
  /** The countries it delivers to (default `any`); it is never offered for an order shipping elsewhere. */
  countries: providerCountriesSchema.default("any"),
  /** The public tracking page, with `{trackingId}` where the tracking id goes. */
  trackingUrl: z.string().max(500).regex(/^https:\/\/[^\s]*\{trackingId\}[^\s]*$/, "Use an https URL containing {trackingId}.").optional(),
  /**
   * The courier books by its own location ids, kept on the store's places
   * under `externalIds.<key>`. The platform refuses a booking whose city,
   * zone or area lacks a `required` id before anything is written (`numeric`:
   * the id must be a positive whole number), and passes the ids as
   * `recipient.locationIds`.
   */
  locations: z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "Use snake_case: a lowercase letter, then at most 31 lowercase letters, digits or underscores."),
    required: z.array(z.enum(["city", "zone", "area"])).max(3)
      .refine((levels) => new Set(levels).size === levels.length, "List each level once.")
      .default([]),
    numeric: z.boolean().default(false),
  }).strict().optional(),
  /** The courier's own booking choices (`courierBookingOptionSchema`), each key once. */
  bookingOptions: z.array(courierBookingOptionSchema).max(10)
    .refine((options) => new Set(options.map((option) => option.key)).size === options.length, "List each option key once.")
    .optional(),
}).strict();

const plain = <K extends ProviderKind>(kind: K) => z.object(base(kind)).strict();

/** A courier-history checker looks up buyers of some countries (its couriers' country). */
export const courierHistoryProviderDescriptorSchema = z.object({
  ...base("courier_history"),
  /** The countries it knows buyers in (default `any`); it is never asked about an order shipping elsewhere. */
  countries: providerCountriesSchema.default("any"),
}).strict();

/** A messaging provider names the chat channels it carries. */
export const messagingProviderDescriptorSchema = z.object({
  ...base("messaging"),
  channels: z.array(z.enum(MESSAGING_CHANNELS)).min(1).max(MESSAGING_CHANNELS.length)
    .refine((channels) => new Set(channels).size === channels.length, "List each channel once."),
}).strict();

/** An address provider knows addresses of some countries (default `any`); checkout asks it only for those. */
export const addressProviderDescriptorSchema = z.object({
  ...base("address"),
  countries: providerCountriesSchema.default("any"),
}).strict();

const PROVIDER_DESCRIPTOR_SCHEMAS = {
  payment: paymentProviderDescriptorSchema,
  courier: courierProviderDescriptorSchema,
  sms: plain("sms"),
  email: plain("email"),
  courier_history: courierHistoryProviderDescriptorSchema,
  tax: plain("tax"),
  translation: plain("translation"),
  ai: plain("ai"),
  messaging: messagingProviderDescriptorSchema,
  push: plain("push"),
  search: plain("search"),
  address: addressProviderDescriptorSchema,
  fx: plain("fx"),
  identity: plain("identity"),
} as const satisfies Record<ProviderKind, z.ZodType>;

export type PaymentProviderDescriptor = z.output<typeof paymentProviderDescriptorSchema>;
export type CourierProviderDescriptor = z.output<typeof courierProviderDescriptorSchema>;
export type CourierHistoryProviderDescriptor = z.output<typeof courierHistoryProviderDescriptorSchema>;
export type MessagingProviderDescriptor = z.output<typeof messagingProviderDescriptorSchema>;
export type AddressProviderDescriptor = z.output<typeof addressProviderDescriptorSchema>;
type PlainProviderDescriptor = z.output<ReturnType<typeof plain>>;

/** One declared provider, flat, as the parsed manifest keeps it. */
export type PluginProviderDeclaration =
  | ({ kind: "payment" } & PaymentProviderDescriptor)
  | ({ kind: "courier" } & CourierProviderDescriptor)
  | ({ kind: "courier_history" } & CourierHistoryProviderDescriptor)
  | ({ kind: "messaging" } & MessagingProviderDescriptor)
  | ({ kind: "address" } & AddressProviderDescriptor)
  | ({ kind: "sms" | "email" | "tax" | "translation" | "ai" | "push" | "search" | "fx" | "identity" } & PlainProviderDescriptor);

/**
 * The manifest's `providers`: grouped by port, as authors write it. The flat
 * list (`[{ kind, ...descriptor }]`) is what a parsed manifest stores and
 * re-parses; it also reads kinds stored under an earlier name
 * (`RENAMED_PROVIDER_KINDS`: `shipping`, `fraud`) and the first manifest's
 * `messaging` (now `sms`). Since the chat `messaging` kind, a flat entry named
 * `messaging` is a chat provider only when it lists `channels`; without them
 * it is the old SMS name.
 */
export const pluginProvidersSchema = z.union([
  z.object(Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, z.array(PROVIDER_DESCRIPTOR_SCHEMAS[kind]).max(PLUGIN_PROVIDERS_MAX).optional()])) as {
    [K in ProviderKind]: z.ZodOptional<z.ZodArray<(typeof PROVIDER_DESCRIPTOR_SCHEMAS)[K]>>;
  }).strict().transform((groups) => PROVIDER_KINDS.flatMap((kind) =>
    (groups[kind] ?? []).map((descriptor) => ({ kind, ...descriptor }) as PluginProviderDeclaration))),
  z.array(z.looseObject({ kind: z.enum([...PROVIDER_KINDS, ...Object.keys(RENAMED_PROVIDER_KINDS) as (keyof typeof RENAMED_PROVIDER_KINDS)[]]) })).max(PLUGIN_PROVIDERS_MAX)
    .transform((entries, context) => entries.map((entry, index) => {
      const { kind: named, ...descriptor } = entry;
      const kind = (named === "messaging" && !("channels" in descriptor) ? "sms" : currentProviderKind(named)) as ProviderKind;
      const parsed = PROVIDER_DESCRIPTOR_SCHEMAS[kind].safeParse(descriptor);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: "custom", path: [index, ...issue.path.map((part) => (typeof part === "symbol" ? String(part) : part))], message: issue.message });
        }
        return z.NEVER;
      }
      return { kind, ...parsed.data } as PluginProviderDeclaration;
    })),
]).default([]).refine((providers) => providers.length <= PLUGIN_PROVIDERS_MAX, `At most ${PLUGIN_PROVIDERS_MAX} providers.`);

/** The operations the host may call on a declared provider: the port's required ones and the declared optional ones. */
export function declaredProviderOperations(declaration: Pick<PluginProviderDeclaration, "kind" | "operations">): string[] {
  return [...PROVIDER_OPERATIONS[declaration.kind].required, ...declaration.operations];
}
