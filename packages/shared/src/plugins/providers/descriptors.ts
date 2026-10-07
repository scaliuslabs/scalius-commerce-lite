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
import { PROVIDER_KINDS, PROVIDER_OPERATIONS, type ProviderKind } from "./kinds";
import { paymentAmountLimitsSchema } from "./payment";

const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const title = z.string().trim().min(1).max(80);
const settingKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
/**
 * The provider's own mark in the plugin package (`assets/pathao.svg`): an SVG
 * or PNG with the app icon's checks, shown beside the provider where the
 * merchant picks it (a pack's providers are different brands).
 */
const providerIcon = z.string().max(128)
  .regex(/^(?!.*\.\.)[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*\.(?:svg|png)$/, "Use a relative lowercase .svg or .png path inside the plugin.");

/**
 * The most providers one app declares. A regional pack bundles a country's
 * integrations in one app (the Bangladesh pack: 4 SMS gateways, 4 fraud
 * checkers, its couriers and a payment gateway), so the limit is sized for
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
  /** Apps redirect the buyer to the provider's hosted page; in-page card forms are built in. */
  flow: z.enum(["hosted"]).default("hosted"),
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
}).strict().superRefine((descriptor, context) => {
  const has = (operation: string) => descriptor.operations.includes(operation);
  // A hosted page returns the buyer, and a buyer may ask whether it went through.
  if (descriptor.flow === "hosted" && (!has("verifyReturn") || !has("queryPayment"))) {
    context.addIssue({ code: "custom", path: ["operations"], message: "A hosted payment provider implements verifyReturn and queryPayment." });
  }
  // A refund whose answer was lost must be asked about, never submitted again.
  if (has("refund") && !has("refundStatus")) {
    context.addIssue({ code: "custom", path: ["operations"], message: "A provider that refunds implements refundStatus." });
  }
});

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
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    required: z.array(z.enum(["city", "zone", "area"])).max(3)
      .refine((levels) => new Set(levels).size === levels.length, "List each level once.")
      .default([]),
    numeric: z.boolean().default(false),
  }).strict().optional(),
}).strict();

const plain = <K extends ProviderKind>(kind: K) => z.object(base(kind)).strict();

/** A fraud checker looks up buyers of some countries (a courier-history service: its couriers' country). */
export const fraudProviderDescriptorSchema = z.object({
  ...base("fraud"),
  /** The countries it knows buyers in (default `any`); it is never asked about an order shipping elsewhere. */
  countries: providerCountriesSchema.default("any"),
}).strict();

const PROVIDER_DESCRIPTOR_SCHEMAS = {
  payment: paymentProviderDescriptorSchema,
  courier: courierProviderDescriptorSchema,
  sms: plain("sms"),
  email: plain("email"),
  fraud: fraudProviderDescriptorSchema,
  tax: plain("tax"),
} as const satisfies Record<ProviderKind, z.ZodType>;

export type PaymentProviderDescriptor = z.output<typeof paymentProviderDescriptorSchema>;
export type CourierProviderDescriptor = z.output<typeof courierProviderDescriptorSchema>;
export type FraudProviderDescriptor = z.output<typeof fraudProviderDescriptorSchema>;
type PlainProviderDescriptor = z.output<ReturnType<typeof plain>>;

/** One declared provider, flat, as the parsed manifest keeps it. */
export type PluginProviderDeclaration =
  | ({ kind: "payment" } & PaymentProviderDescriptor)
  | ({ kind: "courier" } & CourierProviderDescriptor)
  | ({ kind: "fraud" } & FraudProviderDescriptor)
  | ({ kind: "sms" | "email" | "tax" } & PlainProviderDescriptor);

/**
 * The manifest's `providers`: grouped by port, as authors write it. The flat
 * list (`[{ kind, ...descriptor }]`) is what a parsed manifest stores and
 * re-parses; it also accepts the first manifest shape, whose kinds were
 * named `shipping` (now `courier`) and `messaging` (now `sms`).
 */
export const pluginProvidersSchema = z.union([
  z.object(Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, z.array(PROVIDER_DESCRIPTOR_SCHEMAS[kind]).max(PLUGIN_PROVIDERS_MAX).optional()])) as {
    [K in ProviderKind]: z.ZodOptional<z.ZodArray<(typeof PROVIDER_DESCRIPTOR_SCHEMAS)[K]>>;
  }).strict().transform((groups) => PROVIDER_KINDS.flatMap((kind) =>
    (groups[kind] ?? []).map((descriptor) => ({ kind, ...descriptor }) as PluginProviderDeclaration))),
  z.array(z.looseObject({ kind: z.enum([...PROVIDER_KINDS, "shipping", "messaging"]) })).max(PLUGIN_PROVIDERS_MAX)
    .transform((entries, context) => entries.map((entry, index) => {
      const { kind: named, ...descriptor } = entry;
      const kind: ProviderKind = named === "shipping" ? "courier" : named === "messaging" ? "sms" : named;
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
