// Plugin functions (docs/platform/PLUGINS.md): synchronous decision points in
// checkout (Shopify Functions). A function is pure: it receives the input
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
import { PLUGIN_BLOCK_TARGETS } from "./storefront";
import type { PluginFunctionPoint } from "./manifest";

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
  /** Buyer inputs captured on the line (engraving text, gift note…). */
  properties: z.record(z.string().max(64), z.string().max(500)),
}).strict();

export const functionCartSchema = z.object({
  currency: z.string().length(3),
  decimalPlaces: z.number().int().min(0).max(4),
  channel: z.enum(["online_store", "admin", "pos", "agent", "app"]),
  lines: z.array(functionCartLineSchema).max(250),
  subtotalMinor: nonNegativeMinor,
  /** The buyer's segment facts when signed in; null for guests. */
  customer: z.object({
    id,
    /** The customer's tags (Customers → Tags), sorted; at most 50. */
    tags: z.array(z.string().max(64)).max(50),
    orderCount: z.number().int().min(0),
    totalSpentMinor: nonNegativeMinor,
  }).strict().nullable(),
  /** Region only, for rules like "Dhaka only". */
  destination: z.object({
    country: z.string().length(2),
    city: z.string().max(120).nullable(),
    zone: z.string().max(120).nullable(),
  }).strict().nullable(),
  discountCodes: z.array(z.string().max(64)).max(10),
  /**
   * The market the order will be placed in: the market selling to the
   * shipping country (the billing country for an order that ships nothing),
   * else the backup market. `country` is the ISO country that chose it, or
   * null when no country is known yet (then the id is the backup market's).
   */
  market: z.object({
    id,
    country: z.string().length(2).nullable(),
  }).strict(),
  /**
   * Validated checkout attributes the buyer entered, by `<app id>.<key>`.
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
    z.object({ op: z.literal("price"), rateId: id, amountMinor: nonNegativeMinor }).strict(),
    z.object({ op: z.literal("reorder"), rateIds: z.array(id).min(1).max(50) }).strict(),
  ])).max(50),
}).strict();

// ── checkout.payment_methods ──────────────────────────────────────────────

export const checkoutPaymentMethodsOutputSchema = z.object({
  operations: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("hide"), methodId: id }).strict(),
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
export const FUNCTION_PRICE_SOURCES = ["sale", "segment", "market", "fx", "base"] as const;

/**
 * Per line: where its price came from and the bundle it belongs to (an
 * expanded line's components). Only lines priced at `fx` or `base` take an
 * app price: sale, segment and market lists stay authoritative.
 */
export const functionLinePriceFactsSchema = z.object({
  lineId: id,
  source: z.enum(FUNCTION_PRICE_SOURCES),
  bundle: z.object({ id, title: z.string().max(300) }).strict().nullable(),
}).strict();

/**
 * Unit prices in the cart currency's minor units, before buyer-input
 * surcharges (they are added on top). The platform rounds each half-up to
 * the market's price increment. Several apps: the first in priority order
 * that prices a line wins. A line not named keeps its price.
 */
export const cartLinePricesOutputSchema = z.object({
  prices: z.array(z.object({
    lineId: id,
    unitPriceMinor: minor.positive(),
  }).strict()).max(250),
}).strict();

// ── Registry ──────────────────────────────────────────────────────────────

export const buyerUiInputSchema = z.object({
  target: z.enum(PLUGIN_BLOCK_TARGETS), language: z.string().min(1).max(35), locale: z.string().min(1).max(35), currency: z.string().length(3),
  cart: functionCartSchema.nullable(), attributes: checkoutAttributesSchema,
  order: z.object({ orderId: id, status: z.string().max(64), paymentStatus: z.string().max(64), lines: z.array(z.object({ productId: id, variantId: id, quantity: z.number().int().min(1) }).strict()).max(250) }).strict().nullable(),
  customer: z.object({ id }).strict().nullable(), reads,
}).strict();
export type BuyerUiInput = z.infer<typeof buyerUiInputSchema>;

export const PLUGIN_FUNCTION_SCHEMAS = {
  "buyer.ui": { input: buyerUiInputSchema, output: buyerUiOutputSchema },
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
    input: z.object({ cart: functionCartSchema, methods: z.array(z.object({ methodId: id, name: label }).strict()).max(20), reads }).strict(),
    output: checkoutPaymentMethodsOutputSchema,
  },
} as const satisfies Record<PluginFunctionPoint, { input: z.ZodType; output: z.ZodType }>;

/** What a function receives (defaults applied). */
export type PluginFunctionInput<P extends PluginFunctionPoint> = z.infer<(typeof PLUGIN_FUNCTION_SCHEMAS)[P]["input"]>;
/** An input as a caller may write it (defaults left out): what the test harness takes. */
export type PluginFunctionInputDraft<P extends PluginFunctionPoint> = z.input<(typeof PLUGIN_FUNCTION_SCHEMAS)[P]["input"]>;
export type PluginFunctionOutput<P extends PluginFunctionPoint> = z.infer<(typeof PLUGIN_FUNCTION_SCHEMAS)[P]["output"]>;

/** The refusal code of an answer that fails its point's schema; the host skips the app (or blocks, `onError`). */
export const PLUGIN_FUNCTION_INVALID_OUTPUT = "function.invalid_output";

/**
 * A function's answer checked the way the host checks it: the parsed output,
 * or `function.invalid_output` with the first issue's path. The host and the
 * SDK test harness both use this, so a test sees what production does.
 */
export function checkPluginFunctionOutput<P extends PluginFunctionPoint>(
  point: P,
  value: unknown,
): { ok: true; value: PluginFunctionOutput<P> } | { ok: false; code: typeof PLUGIN_FUNCTION_INVALID_OUTPUT; message: string } {
  const parsed = PLUGIN_FUNCTION_SCHEMAS[point].output.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as PluginFunctionOutput<P> };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    code: PLUGIN_FUNCTION_INVALID_OUTPUT,
    message: `Invalid ${point} output${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""}.`,
  };
}
