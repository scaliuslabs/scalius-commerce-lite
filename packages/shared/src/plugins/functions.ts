// Plugin functions (packages/plugin-sdk/docs/apps.md): synchronous decision points in
// checkout (Shopify Functions). Buyer UI is not a function: an app declares it
// as storefront extensions (manifest `storefront.extensions`, one per UI slot)
// and the host renders it through the same pipeline (PLUGIN_EXTENSION_SCHEMAS). A function is pure: it receives the input
// below plus its plugin's settings, does no I/O, and returns an output the
// platform validates and applies. Inputs carry ids, quantities, money in
// integer minor units and customer segments — never contact details. A
// function that throws, times out or returns an invalid output is skipped
// (`fail open`) and the incident is logged for the merchant; no plugin can
// take checkout down. At points in PLUGIN_BLOCKING_FUNCTION_POINTS an app may
// declare `onError: "block"` instead (fail closed).
//
// The order a checkout asks them in: cart.transform (the lines), then
// cart.line_prices (their unit prices), then cart.validate,
// checkout.discounts and checkout.shipping_rates together, then
// checkout.payment_methods. A reaction after the order commits is an event
// handler (`ctx.orders.hold`, `ctx.orders.assessRisk`), not a function.
// Part of the versioned plugin API.

import { z } from "zod";
import { buyerUiOutputSchema, checkoutAttributesSchema } from "./buyer-ui";
import { FUNCTION_READ_AS_PATTERN, FUNCTION_READS_MAX, functionReadsSchema } from "./function-reads";
import { STOREFRONT_UI_SLOTS } from "./storefront-protocol";
import { APP_SCOPED_KEY_MAX_LENGTH, APP_SCOPED_KEY_PATTERN } from "./ids";
import { LINE_PROPERTY_INPUT_LIMITS, LINE_PURCHASE_OPTIONS_MAX } from "../line-properties";
import type { PluginFunctionPoint } from "./manifest";
import { PLUGIN_CUSTOMER_ROLE_PATTERN, PLUGIN_CUSTOMER_ROLE_REF_PATTERN, PLUGIN_CUSTOMER_ROLES_MAX } from "./customer-roles";
import { ORDER_CHANNELS } from "../order-channel";
import { ONLINE_STORE_CHANNEL_ID, SALES_CHANNEL_ID_MAX_LENGTH, SALES_CHANNEL_ID_PATTERN } from "../sales-channels";

const id = z.string().min(1).max(128);
const minor = z.number().int().safe();
const nonNegativeMinor = minor.min(0);
const code = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
const message = z.string().trim().min(1).max(200);
const label = z.string().trim().min(1).max(80);

/** One cart line as functions see it. */
export const functionCartLineSchema = z.object({
  lineId: id,
  productId: id,
  variantId: id,
  sku: z.string().max(128).nullable(),
  title: z.string().max(300),
  quantity: z.number().int().min(1),
  unitPriceMinor: nonNegativeMinor,
  /** After the platform's own discounts, before plugin discounts. */
  lineTotalMinor: nonNegativeMinor,
  categoryIds: z.array(id).max(20),
  collectionIds: z.array(id).max(50),
  brandId: id.nullable(),
  /**
   * Buyer inputs captured on the line, by key: the merchant's own (engraving
   * text, a gift note) and this app's line inputs (`checkout.lineInputs`)
   * under `<app id>.<key>`, each exactly as the order line will freeze it
   * (up to 1,000 characters). Another app's line inputs are never shown.
   */
  properties: z.record(z.string().max(APP_SCOPED_KEY_MAX_LENGTH), z.string().max(LINE_PROPERTY_INPUT_LIMITS.valueLength)),
  /**
   * The SKU is a physical good (not digital, a service or a gift card),
   * whatever delivery the buyer picks: a pickup line still requires shipping
   * in this sense (Shopify's `requiresShipping`).
   */
  requiresShipping: z.boolean().default(true),
  /** The SKU's weight in grams, or null when the merchant has not set one. */
  weightGrams: z.number().finite().min(0).nullable().default(null),
  /**
   * The product's shipping profile (`shp_default` unless the merchant put it
   * in another): delivery prices each profile's lines with its own rates.
   */
  shippingProfileId: id.default("shp_default"),
  /**
   * The purchase options the buyer chose for the line (`<app id>.<key>`,
   * active apps' manifest `checkout.purchaseOptions`), sorted by id, at most
   * one per app: a subscription and another app's protection plan side by
   * side. Empty for a one-time purchase. Buyer checkout requires each owning
   * app's answer for the line from `cart.line_prices` (a price or an
   * add-on); `checkout.discounts` and `cart.validate` handle discounts and
   * eligibility. Staff orders keep staff-set prices. The same SKU with other
   * options is another line.
   */
  purchaseOptions: z.array(z.string().max(APP_SCOPED_KEY_MAX_LENGTH).regex(APP_SCOPED_KEY_PATTERN)).max(LINE_PURCHASE_OPTIONS_MAX).default([]),
}).strict();

/** Who places the order (`orders.channel`, `@scalius/shared/order-channel`). */
export const FUNCTION_CART_CHANNELS = ORDER_CHANNELS;

export const functionCartSchema = z.object({
  /** The currency the buyer pays in (the market's): every `*Minor` amount here is in it. */
  currency: z.string().length(3),
  decimalPlaces: z.number().int().min(0).max(4),
  /**
   * The store's own currency, the one your settings' amounts are in. It is
   * `currency` unless the market sells in another; answer a fixed amount
   * with `currency: "store"` and core converts it as it does a product price.
   */
  storeCurrency: z.object({ code: z.string().length(3), decimalPlaces: z.number().int().min(0).max(4) }).strict(),
  channel: z.enum(FUNCTION_CART_CHANNELS),
  /**
   * The sales channel the order sells from (`orders.sales_channel_id`,
   * MARKETS-DESIGN D6): the online store for the storefront, the agents
   * channel for a buyer agent, the channel staff or an app chose for a manual
   * order (else the online store).
   */
  salesChannelId: z.string().max(SALES_CHANNEL_ID_MAX_LENGTH).regex(SALES_CHANNEL_ID_PATTERN).default(ONLINE_STORE_CHANNEL_ID),
  lines: z.array(functionCartLineSchema).max(250),
  subtotalMinor: nonNegativeMinor,
  /** The buyer's segment facts when signed in; null for guests. */
  customer: z.object({
    id,
    /** The customer's tags (Customers → Tags), sorted; at most 50. */
    tags: z.array(z.string().max(64)).max(50),
    /**
     * The customer segments that price this cart for the buyer, sorted, at
     * most 50: the segments of the market's live segment price lists on the
     * cart's SKUs that the buyer is in (`resolvePrice()`'s segment source).
     * Not every segment the buyer is in: membership is evaluated only where
     * a segment prices the cart. Empty when none applies.
     */
    segmentIds: z.array(id).max(50).default([]),
    orderCount: z.number().int().min(0),
    totalSpentMinor: nonNegativeMinor,
    /**
     * The roles this app granted the customer (`ctx.customers.roles`), sorted
     * by role: each app sees only its own. Empty when it granted none.
     */
    roles: z.array(z.object({
      role: z.string().regex(PLUGIN_CUSTOMER_ROLE_PATTERN),
      ref: z.string().regex(PLUGIN_CUSTOMER_ROLE_REF_PATTERN).nullable(),
    }).strict()).max(PLUGIN_CUSTOMER_ROLES_MAX).default([]),
  }).strict().nullable(),
  /** Region only, for rules like "Dhaka only". */
  destination: z.object({
    country: z.string().length(2),
    city: z.string().max(120).nullable(),
    zone: z.string().max(120).nullable(),
  }).strict().nullable(),
  discountCodes: z.array(z.string().max(64)).max(10),
  /**
   * Checkout's market, selected before transforms from the initial cart and
   * delivery choice: shipping country for delivery, billing country for
   * non-shipping lines, backup for pickup. Every later hook and the order
   * retain it even if a transform changes fulfilment. `country` is the ISO
   * country that chose it, or null for pickup or an addressless preview;
   * a preview may use its URL market presence before a country is known.
   */
  market: z.object({
    id,
    country: z.string().length(2).nullable(),
  }).strict(),
  /**
   * Validated checkout attributes the buyer entered, by `<app id>.<key>`:
   * only the receiving app's own (the host drops every other app's answers
   * before a function or extension runs).
   */
  attributes: checkoutAttributesSchema,
}).strict();
export type FunctionCart = z.infer<typeof functionCartSchema>;

// ── cart.validate ─────────────────────────────────────────────────────────

export const cartValidateOutputSchema = z.object({
  /** Any error blocks checkout and is shown to the buyer (on its line when `lineId` is set). */
  errors: z.array(z.object({ code, message, lineId: id.optional() }).strict()).max(20),
}).strict();

// ── Declared reads ────────────────────────────────────────────────────────

/**
 * The function's declared reads (`reads` in the manifest, function-reads.ts),
 * resolved by the host: by `as`, `{ revision, data } | null` for a
 * single-key read, `Record<key, { revision, data }>` for a per-line read.
 * Empty when the function declares none.
 */
const reads = functionReadsSchema.default({});

// ── checkout.discounts ────────────────────────────────────────────────────

/**
 * A discount's class, from its target (Shopify's discount classes): `lines`
 * is a product discount, `order` an order discount, `shipping` a shipping
 * discount.
 */
export const FUNCTION_DISCOUNT_CLASSES = ["product", "order", "shipping"] as const;
export type FunctionDiscountClass = (typeof FUNCTION_DISCOUNT_CLASSES)[number];

export function functionDiscountClass(targetKind: "lines" | "order" | "shipping"): FunctionDiscountClass {
  return targetKind === "lines" ? "product" : targetKind;
}

export const checkoutDiscountsOutputSchema = z.object({
  discounts: z.array(z.object({
    title: label,
    /** A code this discount answers to, when it is code-driven. */
    code: z.string().max(64).optional(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("order") }).strict(),
      z.object({ kind: z.literal("lines"), lineIds: z.array(id).min(1).max(250) }).strict(),
      z.object({ kind: z.literal("shipping") }).strict(),
    ]),
    value: z.discriminatedUnion("type", [
      z.object({ type: z.literal("percentage"), percent: z.number().gt(0).max(100) }).strict(),
      z.object({ type: z.literal("fixed_amount"), amountMinor: minor.positive() }).strict(),
    ]),
    /** Caps the discount's total. */
    maxAmountMinor: minor.positive().optional(),
    /**
     * The classes this discount stacks with; every key defaults to true (it
     * stacks with everything). Two discounts both apply only when each
     * combines with the other's class; the platform's own discounts combine
     * with everything, but an app discount that does not combine with their
     * class is skipped when they discounted that class. A skipped discount
     * claims no code and spends no `commit`. The same shape as a store
     * discount's `combinesWith` (`discounts.create`), keys optional here.
     */
    combinesWith: z.object({
      product: z.boolean().optional(),
      order: z.boolean().optional(),
      shipping: z.boolean().optional(),
    }).strict().optional(),
  }).strict()).max(10),
  /**
   * New versions of records this function read (`as`: a single-key object
   * read), committed with the order (same batch, each at the revision the
   * function saw) only when one of these discounts applies; a concurrent
   * change aborts the order instead. A read whose key resolved to no id (a
   * guest's `customer` read, an empty attribute or hop) cannot be committed.
   */
  commit: z.array(z.object({
    as: z.string().regex(FUNCTION_READ_AS_PATTERN),
    record: z.record(z.string(), z.unknown()),
  }).strict()).max(FUNCTION_READS_MAX).optional(),
}).strict();

// ── checkout.shipping_rates ───────────────────────────────────────────────

export const functionShippingRateSchema = z.object({
  rateId: id,
  name: label,
  amountMinor: nonNegativeMinor,
  kind: z.enum(["delivery", "pickup"]),
}).strict();

export const checkoutShippingRatesOutputSchema = z.object({
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("hide"), rateId: id }).strict(),
    z.object({ op: z.literal("rename"), rateId: id, name: label }).strict(),
    /**
     * Sets a rate's fee before the store's free-over waivers. With
     * `profileId`, only that shipping profile's share of the rate (its
     * lines carry `shippingProfileId`); without, the whole rate. A share the
     * store waived stays free, and a free-delivery profile's lines always
     * ship free.
     */
    z.object({ op: z.literal("price"), rateId: id, amountMinor: nonNegativeMinor, profileId: id.optional() }).strict(),
    z.object({ op: z.literal("reorder"), rateIds: z.array(id).min(1).max(50) }).strict(),
  ])).max(50),
}).strict();

// ── checkout.payment_methods ──────────────────────────────────────────────

export const checkoutPaymentMethodsOutputSchema = z.object({
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("hide"), methodId: id }).strict(),
    /**
     * Offer a `gated` method to this buyer: the built-in invoice (net terms)
     * when the merchant lets apps decide who pays later, or the app's own
     * deferred (pay later) method, which is never offered without its app's
     * allow. Any other method is skipped; a hide wins over an allow.
     */
    z.object({ op: z.literal("allow"), methodId: id }).strict(),
    z.object({ op: z.literal("rename"), methodId: id, name: label }).strict(),
    z.object({ op: z.literal("reorder"), methodIds: z.array(id).min(1).max(20) }).strict(),
  ])).max(40),
}).strict();

// ── cart.transform ────────────────────────────────────────────────────────

/** The most component SKUs one expanded line becomes. */
export const CART_TRANSFORM_COMPONENTS_MAX = 20;

/**
 * Shopify's cartTransform: what the cart's lines are, never what they cost.
 *
 * - `expand`: the line (a bundle SKU) is sold as these component SKUs, each
 *   `quantity` per unit of the line. The components are the order's lines:
 *   stock, tax and fulfilment follow them. Each is priced like any SKU (an
 *   app sets bundle prices with `cart.line_prices` or a discount).
 * - `merge`: the lines are one bundle on the order (shown under `title`);
 *   prices and stock are unchanged.
 *
 * A line is in at most one operation; a later one naming it is skipped.
 */
export const cartTransformOutputSchema = z.object({
  operations: z.array(z.discriminatedUnion("op", [
    z.object({
      op: z.literal("expand"),
      lineId: id,
      /** The bundle's name on the order (default: the line's title). */
      title: label.optional(),
      components: z.array(z.object({
        variantId: id,
        quantity: z.number().int().min(1).max(100),
      }).strict()).min(1).max(CART_TRANSFORM_COMPONENTS_MAX),
    }).strict(),
    z.object({
      op: z.literal("merge"),
      lineIds: z.array(id).min(2).max(50),
      title: label,
    }).strict(),
  ])).max(50),
}).strict();

// ── cart.line_prices ──────────────────────────────────────────────────────

/** Where a line's unit price came from (`resolvePrice()`). */
export const FUNCTION_PRICE_SOURCES = ["sale", "segment", "market", "fx", "base", "override"] as const;

/**
 * Per line: where its price came from and the bundle it belongs to (an
 * expanded line's components). A one-time line takes an app price only when
 * it is priced at `sale`, `fx` or `base`: override, segment and market lists stay
 * authoritative. A line bought with purchase options takes a price only from
 * an app whose option it carries, which outranks every list (`resolvePrice()`).
 */
export const functionLinePriceFactsSchema = z.object({
  lineId: id,
  source: z.enum(FUNCTION_PRICE_SOURCES),
  bundle: z.object({ id, title: z.string().max(300) }).strict().nullable(),
}).strict();

/** App add-ons one line takes, from every app together; later ones are skipped and logged. */
export const LINE_ADJUSTMENTS_PER_LINE_MAX = 5;
/** The largest add-on to one unit, in minor units. */
export const LINE_ADJUSTMENT_MAX_MINOR = 1_000_000_000_000;

/** Which currency an answered amount is in: `cart` (the default, `cart.currency`) or `store` (`cart.storeCurrency`). */
export const FUNCTION_AMOUNT_CURRENCIES = ["cart", "store"] as const;
/** Absent: `cart`. */
const amountCurrency = z.enum(FUNCTION_AMOUNT_CURRENCIES).optional();
/** The largest share of a line an add-on takes, in percent. */
export const LINE_ADJUSTMENT_PERCENT_MAX = 1_000;
/** A share with at most two decimals (`12.5` is 12.5%). */
const percentOfUnit = z.number().finite().positive().max(LINE_ADJUSTMENT_PERCENT_MAX)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "At most two decimals.");

/**
 * `prices`: unit prices in minor units, before buyer-input surcharges (they
 * are added on top), for one-time lines priced at `sale`, `fx` or `base` and
 * for lines bought with the app's own purchase option (above every list).
 * Several apps: the first in priority order that prices a one-time line wins,
 * and the merchant sees a notice naming the app whose price was not used. A
 * sale only lowers that offer. An unnamed one-time line keeps its price. A
 * purchase-option line takes a price only from an app whose option it
 * carries, and each of those apps must answer it with a price or an add-on,
 * else checkout refuses; two of them pricing one line refuse too
 * (`purchase_options_conflict`): one line has one price.
 *
 * `adjustments`: add-ons to each unit of a line (an engraving's letters, a
 * gift wrap, a protection plan), applied after the whole price precedence,
 * so sale, segment, app and price-list lines take them too. An add-on is a
 * fixed `amountMinor` or a `percent` of the line's unit price as checkout
 * prices it (after every price, before add-ons and discounts; currency-free,
 * so one share prices every market). Every app's add-ons apply, in priority
 * order, at most LINE_ADJUSTMENTS_PER_LINE_MAX per line, never on gift cards
 * or bundle lines: an add-on the line cannot take refuses checkout
 * (`add_on_unavailable`), so a buyer never gets what it pays for unpaid. The
 * buyer sees each as a line component ("Add-on: <title>") in the cart,
 * checkout, receipt and emails; tax, discounts, totals and refunds include it
 * as part of the unit price.
 *
 * Amounts are in the cart's currency unless the answer says
 * `currency: "store"`: then core converts them with the catalogue's own
 * conversion at the checkout's one locked rate, the market's price
 * adjustment included (`storeAmountMinor`). A price then rounds and ends
 * exactly as a product price does (৳1,200 in a USD market at 0.0082, +10%,
 * ending .99 is $10.99, as the product is). An add-on rounds half-up to the
 * market's increment without the market's rounding step or ending, which
 * make the item's price point (a ৳50 wrap there is $0.45, not $0.99). A
 * cart-currency amount, and a store-currency one in the store's own
 * currency, rounds half-up to the increment (৳50.50 at whole taka is ৳51).
 * A positive amount never rounds to nothing (it takes one increment); a
 * fixed 0 is a free extra, frozen on the order line like any add-on, so an
 * app decides what to deliver from the order line, never from its current
 * settings.
 */
export const cartLinePricesOutputSchema = z.object({
  prices: z.array(z.object({
    lineId: id,
    unitPriceMinor: minor.positive(),
    currency: amountCurrency,
  }).strict()).max(250).default([]),
  adjustments: z.array(z.union([
    z.object({
      lineId: id,
      /**
       * Added to each unit of the line. 0 records a free extra on the line
       * (the buyer sees "Add-on: <title>" with no price), so the order line
       * says what was sold even when it cost nothing.
       */
      amountMinor: minor.nonnegative().max(LINE_ADJUSTMENT_MAX_MINOR),
      currency: amountCurrency,
      /** What the buyer sees on the line ("Engraving, 6 letters"). */
      title: label,
    }).strict(),
    z.object({
      lineId: id,
      /** Added to each unit: this share of the unit price checkout charges for the item. */
      percent: percentOfUnit,
      title: label,
    }).strict(),
  ])).max(250).default([]),
}).strict();

// ── Registry ──────────────────────────────────────────────────────────────

export const buyerUiInputSchema = z.object({
  target: z.enum(STOREFRONT_UI_SLOTS), language: z.string().min(1).max(35), locale: z.string().min(1).max(35), currency: z.string().length(3),
  cart: functionCartSchema.nullable(), attributes: checkoutAttributesSchema,
  order: z.object({ orderId: id, status: z.string().max(64), paymentStatus: z.string().max(64), lines: z.array(z.object({ productId: id, variantId: id, quantity: z.number().int().min(1) }).strict()).max(250) }).strict().nullable(),
  customer: z.object({ id }).strict().nullable(), reads,
}).strict();
export type BuyerUiInput = z.infer<typeof buyerUiInputSchema>;

export const PLUGIN_FUNCTION_SCHEMAS = {
  "cart.transform": {
    input: z.object({ cart: functionCartSchema, reads }).strict(),
    output: cartTransformOutputSchema,
  },
  "cart.line_prices": {
    input: z.object({
      cart: functionCartSchema,
      lines: z.array(functionLinePriceFactsSchema).max(250),
      reads,
    }).strict(),
    output: cartLinePricesOutputSchema,
  },
  "cart.validate": {
    input: z.object({ cart: functionCartSchema, reads }).strict(),
    output: cartValidateOutputSchema,
  },
  "checkout.discounts": {
    input: z.object({ cart: functionCartSchema, reads }).strict(),
    output: checkoutDiscountsOutputSchema,
  },
  "checkout.shipping_rates": {
    input: z.object({ cart: functionCartSchema, rates: z.array(functionShippingRateSchema).max(50), reads }).strict(),
    output: checkoutShippingRatesOutputSchema,
  },
  "checkout.payment_methods": {
    input: z.object({
      cart: functionCartSchema,
      methods: z.array(z.object({
        methodId: id,
        name: label,
        /** Offered only if an app answers `{ op: "allow" }` (the invoice, when the merchant lets apps decide). */
        gated: z.literal(true).optional(),
      }).strict()).max(20),
      reads,
    }).strict(),
    output: checkoutPaymentMethodsOutputSchema,
  },
} as const satisfies Record<PluginFunctionPoint, { input: z.ZodType; output: z.ZodType }>;

/**
 * A storefront extension's render (manifest `storefront.extensions`): the
 * input for one UI slot of the buyer's own pages (cart, checkout, the
 * receipt, account) and the `ui` tree it answers, or null to show nothing.
 */
export const PLUGIN_EXTENSION_SCHEMAS = { input: buyerUiInputSchema, output: buyerUiOutputSchema } as const;

/**
 * The host's run name for extension renders. The host runs them through the
 * function pipeline (declared reads, limits, incident logs) under this
 * name; it is not a function point and no manifest names it.
 */
export const PLUGIN_EXTENSION_RUN = "buyer.ui";
/** What the host runs through the function pipeline: every function point and the extension render. */
export type PluginRunPoint = PluginFunctionPoint | typeof PLUGIN_EXTENSION_RUN;
const PLUGIN_RUN_SCHEMAS = { ...PLUGIN_FUNCTION_SCHEMAS, [PLUGIN_EXTENSION_RUN]: PLUGIN_EXTENSION_SCHEMAS } as const satisfies Record<PluginRunPoint, { input: z.ZodType; output: z.ZodType }>;

/** A run's log source as the merchant reads it: `function:<point>`, or `extension:<target>` for a render. */
export function pluginRunSource(point: PluginRunPoint, input: unknown): string {
  if (point !== PLUGIN_EXTENSION_RUN) return `function:${point}`;
  const target = typeof input === "object" && input !== null ? (input as { target?: unknown }).target : undefined;
  return `extension:${typeof target === "string" ? target : "unknown"}`;
}

/** The input and output schemas of a run: a function point's, or the extension render's. */
export function pluginRunSchemas<P extends PluginRunPoint>(point: P): (typeof PLUGIN_RUN_SCHEMAS)[P] {
  return PLUGIN_RUN_SCHEMAS[point];
}

/** What a function (or the extension render) receives (defaults applied). */
export type PluginFunctionInput<P extends PluginRunPoint> = z.infer<(typeof PLUGIN_RUN_SCHEMAS)[P]["input"]>;
/** An input as a caller may write it (defaults left out): what the test harness takes. */
export type PluginFunctionInputDraft<P extends PluginRunPoint> = z.input<(typeof PLUGIN_RUN_SCHEMAS)[P]["input"]>;
/** An answer as the platform reads it (defaults applied). */
export type PluginFunctionOutput<P extends PluginRunPoint> = z.infer<(typeof PLUGIN_RUN_SCHEMAS)[P]["output"]>;
/** An answer as a function writes it (defaults may be left out). */
export type PluginFunctionAnswer<P extends PluginRunPoint> = z.input<(typeof PLUGIN_RUN_SCHEMAS)[P]["output"]>;

/** The refusal code of an answer that fails its point's schema; the host skips the app (or blocks, `onError`). */
export const PLUGIN_FUNCTION_INVALID_OUTPUT = "function_invalid_output";

/**
 * A function's answer checked the way the host checks it: the parsed output,
 * or `function_invalid_output` with the first issue's path. The host and the
 * SDK test harness both use this, so a test sees what production does.
 */
export function checkPluginFunctionOutput<P extends PluginRunPoint>(
  point: P,
  value: unknown,
): { ok: true; value: PluginFunctionOutput<P> } | { ok: false; code: typeof PLUGIN_FUNCTION_INVALID_OUTPUT; message: string } {
  const parsed = PLUGIN_RUN_SCHEMAS[point].output.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as PluginFunctionOutput<P> };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    code: PLUGIN_FUNCTION_INVALID_OUTPUT,
    message: `Invalid ${point === PLUGIN_EXTENSION_RUN ? "extension" : point} output${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""}.`,
  };
}
