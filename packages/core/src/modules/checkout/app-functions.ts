// Checkout app functions (docs/platform/PLUGINS.md, "Functions"): the cart an
// app sees and the rules that merge what apps return into checkout. The API
// runs the apps (apps/api/src/plugins/checkout-functions.ts); everything here
// is either one bounded read or pure.
//
// Discount stacking (`checkout.discounts`), one rule for the quote, the order
// and the cart's discount preview:
//
// 1. Platform pricing first: promotions (automatic and typed codes) or
//    quantity bundles, whichever `resolveBundlePromotionInterplay` picks.
//    Apps see each line's total after that (`lineTotalMinor`).
// 2. App discounts apply after it, apps in priority order (lower first, then
//    app id), each app's discounts in the order it returned them.
// 3. Each discount is taken from what is left after everything before it, so
//    no line and no delivery charge ever goes below zero.
// 4. Percentage: of what is left, half-up to the market's price increment (a
//    BDT store's default: whole taka). Fixed amount: floored to the increment.
//    `maxAmountMinor` caps the discount's total (also floored to it).
// 5. Targets: `order` spreads over every line that can take a discount by
//    what is left on it (largest remainder, in increments); `lines` over the
//    listed lines the same way; `shipping` lowers the delivery charge only.
// 6. Gift-card lines never take an app discount (a gift card is money).
// 7. A code-driven discount (`code`) applies only when the buyer entered that
//    code. A code that only an app answers to is no longer "not found".
// 8. A discount naming a line that is not in the cart is skipped and logged
//    for the merchant; nothing is guessed.
// 9. Tax is calculated after every discount: the tax quote takes the
//    platform and app allocations together.

import { DELIVERY_HIERARCHY_COUNTRY, MARKET_COUNTRY_PATTERN } from "@scalius/shared/markets";
import type { Database } from "@scalius/database/client";
import { BACKUP_MARKET_ID, categoryClosure, collections, customerTagLinks, customers, orders, productVariants, products } from "@scalius/database/schema";
import {
  functionCartSchema,
  type FunctionCart,
  type CheckoutAttribute,
  type BuyerUiBlock,
  type BuyerUiInput,
  type PluginBlockTarget,
  type PluginFunctionInput,
  type PluginFunctionOutput,
  type PluginFunctionPoint,
} from "@scalius/shared/plugins";
import { floorToIncrementMinor, percentOfMinor, roundToIncrementMinor } from "@scalius/shared/money";
import { and, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { collectionMembershipForConfig } from "../collections";
import { orderMarketIdSql } from "../markets";
import { allocateMinorAmount, type TaxDiscountAllocationInput } from "../tax";
import type { AppDiscountTarget, AppliedAppDiscount, AppObjectCommit, CheckoutRateOption } from "@scalius/shared/checkout-app-facts";
export type { AppDiscountTarget, AppliedAppDiscount, AppObjectCommit, CheckoutRateOption };

// ── The runner checkout is given ────────────────────────────────────────────

/** Checkout refused because an app registered with `onError: "block"` could not answer. */
export const CHECKOUT_APP_UNAVAILABLE_REASON = "CHECKOUT_APP_UNAVAILABLE";

export interface CheckoutAppFunctionResult<P extends PluginFunctionPoint> {
  pluginId: string;
  /** The app's name, as the merchant sees it (manifest `name`). */
  appName: string;
  priority: number;
  output: PluginFunctionOutput<P>;
  /** checkout.discounts: the snapshot write the answer commits with the order, checked by the platform. */
  commit?: AppObjectCommit;
}

/**
 * The apps a checkout request asks. Built once per request by the API from
 * one read (no module state); `points` is empty when no active app
 * implements a point, and then checkout does no app work at all. `run`
 * returns the valid outputs in priority order; an app that throws, times out
 * or returns an invalid output is left out and logged (fail-open). The same
 * point with the same input returns the same outcome within the request.
 */
export interface CheckoutAppFunctions {
  readonly points: ReadonlySet<PluginFunctionPoint>;
  readonly attributes?: ReadonlyArray<{ appId: string; fields: CheckoutAttribute[] }>;
  buyerUi?(input: Partial<Omit<BuyerUiInput, "target">> & { targets: readonly PluginBlockTarget[]; currency: string }): Promise<BuyerUiBlock[]>;
  run<P extends PluginFunctionPoint>(point: P, input: PluginFunctionInput<P>): Promise<Array<CheckoutAppFunctionResult<P>>>;
  /** A valid-looking output checkout could not use (an unknown line or rate): logged for the merchant. */
  report(pluginId: string, point: PluginFunctionPoint, message: string): void;
}

export const NO_CHECKOUT_APP_FUNCTIONS: CheckoutAppFunctions = {
  points: new Set(),
  run: async () => [],
  report: () => undefined,
};

/** Points that need the app cart. */
const CART_POINTS: readonly PluginFunctionPoint[] = [
  "cart.validate",
  "checkout.discounts",
  "checkout.shipping_rates",
  "checkout.payment_methods",
  "order.risk",
  "buyer.ui",
];

export function wantsAppCart(apps: CheckoutAppFunctions | undefined, points: readonly PluginFunctionPoint[] = CART_POINTS): boolean {
  return Boolean(apps && points.some((point) => apps.points.has(point)));
}

// ── The cart an app sees ────────────────────────────────────────────────────

export interface AppFunctionCartFacts {
  products: Map<string, { categoryIds: string[]; collectionIds: string[]; brandId: string | null }>;
  skus: Map<string, string | null>;
  customer: FunctionCart["customer"];
  market: FunctionCart["market"];
}

/** Where the cart ships, as the checkout knows it (the country is absent in Bangladesh's delivery hierarchy). */
export interface AppCartDestinationSource {
  country?: string | null;
  city: string | null;
  zone: string | null;
}

/** The destination an app sees: regions only, or null when nothing ships. */
function appCartDestination(source: AppCartDestinationSource | null): FunctionCart["destination"] {
  if (!source || !(source.city || source.zone || source.country)) return null;
  return {
    country: source.country ?? DELIVERY_HIERARCHY_COUNTRY,
    city: source.city?.slice(0, 120) ?? null,
    zone: source.zone?.slice(0, 120) ?? null,
  };
}

/**
 * The country that places the order in a market: the shipping country, else
 * (an order that ships nothing) the billing country, else none. Same rule as
 * the order insert (`orderMarketIdSql`).
 */
export function appCartMarketCountry(destination: AppCartDestinationSource | null, billingCountry?: string | null): string | null {
  const country = (appCartDestination(destination)?.country ?? billingCountry ?? "").trim().toUpperCase();
  return MARKET_COUNTRY_PATTERN.test(country) ? country : null;
}

function idList(column: AnyColumn, ids: readonly string[]): SQL {
  return sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
}

/**
 * The catalog and customer facts an app cart needs, in one read batch: each
 * product's category (with its ancestors), collections and brand, each SKU,
 * and the signed-in customer's tags, order count and spend, and the market
 * of the order's country. Called only when an active app implements a point.
 */
export async function loadAppFunctionCartFacts(
  db: Database,
  input: {
    productIds: readonly string[];
    variantIds: readonly string[];
    customerId?: string | null;
    /** `appCartMarketCountry()` of the cart: names its market (null: the backup market). */
    marketCountry: string | null;
  },
): Promise<AppFunctionCartFacts> {
  const productIds = [...new Set(input.productIds)];
  const variantIds = [...new Set(input.variantIds)];
  const customerId = input.customerId?.trim() || null;
  const statements = [
    db.select({ id: products.id, categoryId: products.categoryId, brandId: products.brandId })
      .from(products).where(idList(products.id, productIds)),
    db.select({ productId: products.id, ancestorId: categoryClosure.ancestorId, depth: categoryClosure.depth })
      .from(products)
      .innerJoin(categoryClosure, eq(categoryClosure.descendantId, products.categoryId))
      .where(idList(products.id, productIds)),
    db.select({ id: collections.id, config: collections.config })
      .from(collections)
      .where(and(eq(collections.isActive, true), isNull(collections.deletedAt))),
    db.select({ id: productVariants.id, sku: productVariants.sku })
      .from(productVariants).where(idList(productVariants.id, variantIds)),
    // Orders that never became sales (cancelled, incomplete) count toward neither.
    db.select({
      id: customers.id,
      orderCount: sql<number>`(SELECT COUNT(*) FROM ${orders} WHERE ${orders.accountOwnerCustomerId} = ${customers.id}
        AND ${orders.deletedAt} IS NULL AND ${orders.status} NOT IN ('cancelled', 'incomplete'))`,
      totalSpentMinor: sql<number>`(SELECT COALESCE(SUM(${orders.totalAmountMinor}), 0) FROM ${orders}
        WHERE ${orders.accountOwnerCustomerId} = ${customers.id}
        AND ${orders.deletedAt} IS NULL AND ${orders.status} NOT IN ('cancelled', 'incomplete'))`,
      // Tags never contain a comma (customer_tag_links_tag_shape), so the join is lossless.
      tags: sql<string | null>`(SELECT group_concat(tag_link.tag, ',') FROM (
        SELECT ${customerTagLinks.tag} AS tag FROM ${customerTagLinks}
        WHERE ${customerTagLinks.customerId} = ${customers.id} ORDER BY ${customerTagLinks.tag} LIMIT 50) AS tag_link)`,
    }).from(customers).where(and(eq(customers.id, customerId ?? ""), isNull(customers.deletedAt))),
    // The order's market, in the same batch: one more statement, no more waves.
    db.select({ id: orderMarketIdSql(input.marketCountry) }).from(sql`(SELECT 1) AS order_market_scope`),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle batch tuple typing
  const [productRows, ancestorRows, collectionRows, variantRows, customerRows, marketRows] = await db.batch(statements as any) as [
    Array<{ id: string; categoryId: string | null; brandId: string | null }>,
    Array<{ productId: string; ancestorId: string; depth: number }>,
    Array<{ id: string; config: unknown }>,
    Array<{ id: string; sku: string | null }>,
    Array<{ id: string; orderCount: number; totalSpentMinor: number; tags: string | null }>,
    Array<{ id: string }>,
  ];

  const ancestors = new Map<string, Array<{ id: string; depth: number }>>();
  for (const row of ancestorRows) {
    const list = ancestors.get(row.productId) ?? [];
    list.push({ id: row.ancestorId, depth: Number(row.depth) });
    ancestors.set(row.productId, list);
  }
  const memberships = collectionRows.map((row) => ({ id: row.id, ...collectionMembershipForConfig(row.config) }));
  const facts: AppFunctionCartFacts = {
    products: new Map(),
    skus: new Map(),
    customer: null,
    market: { id: marketRows[0]?.id ?? BACKUP_MARKET_ID, country: input.marketCountry },
  };
  for (const row of productRows) {
    // The product's own category first, then its ancestors nearest first.
    const categoryIds = (ancestors.get(row.id) ?? [])
      .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))
      .map((entry) => entry.id);
    if (row.categoryId && !categoryIds.includes(row.categoryId)) categoryIds.unshift(row.categoryId);
    const collectionIds = memberships
      .filter((collection) => collection.productIds.includes(row.id)
        || (row.categoryId !== null && collection.categoryIds.includes(row.categoryId)))
      .map((collection) => collection.id)
      .sort();
    facts.products.set(row.id, { categoryIds: categoryIds.slice(0, 20), collectionIds: collectionIds.slice(0, 50), brandId: row.brandId });
  }
  for (const row of variantRows) facts.skus.set(row.id, row.sku?.trim() ? row.sku.trim().slice(0, 128) : null);
  const customer = customerRows[0];
  if (customer) {
    facts.customer = {
      id: customer.id,
      tags: (customer.tags ?? "").split(",").filter(Boolean).slice(0, 50),
      orderCount: Math.max(0, Number(customer.orderCount) || 0),
      totalSpentMinor: Math.max(0, Number(customer.totalSpentMinor) || 0),
    };
  }
  return facts;
}

export interface AppCartLineSource {
  /** The tax allocation line id (`cart:<index>:<variantId>`): stable from quote to order. */
  lineId: string;
  productId: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPriceMinor: number;
  /** The platform's discount on the line (promotions or bundles). */
  discountMinor: number;
  properties: ReadonlyArray<{ key: string; value: string }>;
}

/** The app cart (`functionCartSchema`) from the authoritative checkout state. */
export function buildAppFunctionCart(input: {
  currency: { code: string; decimalPlaces: number };
  channel: FunctionCart["channel"];
  lines: readonly AppCartLineSource[];
  facts: AppFunctionCartFacts;
  /**
   * The shipping country (absent: Bangladesh) and its city and (in Bangladesh)
   * thana names; null when nothing ships (pickup, digital, service).
   */
  destination: AppCartDestinationSource | null;
  discountCodes: readonly string[];
  attributes?: Record<string, string>;
}): FunctionCart {
  const lines = input.lines.map((line) => {
    const product = input.facts.products.get(line.productId);
    const grossMinor = line.unitPriceMinor * line.quantity;
    const properties: Record<string, string> = {};
    for (const property of line.properties) {
      const key = property.key.slice(0, 64);
      if (key && !(key in properties)) properties[key] = property.value.slice(0, 500);
    }
    return {
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      sku: input.facts.skus.get(line.variantId) ?? null,
      title: line.title.slice(0, 300),
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: Math.max(0, grossMinor - Math.min(grossMinor, line.discountMinor)),
      categoryIds: product?.categoryIds ?? [],
      collectionIds: product?.collectionIds ?? [],
      brandId: product?.brandId ?? null,
      properties,
    };
  });
  const cart: FunctionCart = {
    currency: input.currency.code.toUpperCase(),
    decimalPlaces: input.currency.decimalPlaces,
    channel: input.channel,
    lines,
    subtotalMinor: lines.reduce((total, line) => total + line.lineTotalMinor, 0),
    customer: input.facts.customer,
    // Regions only, never an address: the country, its city and, in
    // Bangladesh's delivery hierarchy, the thana.
    destination: appCartDestination(input.destination),
    discountCodes: [...new Set(input.discountCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))]
      .slice(0, 10)
      .map((code) => code.slice(0, 64)),
    market: input.facts.market,
    attributes: input.attributes ?? {},
  };
  // A cart that fails its own schema is a platform bug, not an app's.
  return functionCartSchema.parse(cart);
}

// ── cart.validate ───────────────────────────────────────────────────────────

/** An app rule the cart breaks; any one blocks checkout. */
export interface CheckoutRuleError {
  code: string;
  /** Written by the app for the buyer; shown as text. */
  message: string;
  /** The cart line it is about (its request index), or null for the whole cart. */
  index: number | null;
  cartKey: string | null;
}

/** `details.reason` of the refusal when an app rule blocks checkout. */
export const CHECKOUT_RULES_FAILED_REASON = "cart_rules";

export function collectCheckoutRuleErrors(
  results: ReadonlyArray<CheckoutAppFunctionResult<"cart.validate">>,
  lines: ReadonlyMap<string, { index: number; cartKey: string | null }>,
  apps?: Pick<CheckoutAppFunctions, "report">,
): CheckoutRuleError[] {
  const errors: CheckoutRuleError[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const error of result.output.errors) {
      const line = error.lineId ? lines.get(error.lineId) : undefined;
      if (error.lineId && !line) apps?.report(result.pluginId, "cart.validate", `Error ${error.code} names line ${error.lineId}, which is not in the cart; shown for the whole cart.`);
      const entry: CheckoutRuleError = {
        code: error.code,
        message: error.message,
        index: line?.index ?? null,
        cartKey: line?.cartKey ?? null,
      };
      const key = `${entry.index}\u0000${entry.code}\u0000${entry.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push(entry);
    }
  }
  return errors;
}

// ── checkout.discounts ──────────────────────────────────────────────────────

export interface AppDiscountLineInput {
  lineId: string;
  /** Unit price × quantity. */
  grossMinor: number;
  /** What the platform already took off the line. */
  platformDiscountMinor: number;
  /** Gift-card lines never take an app discount. */
  giftCard?: boolean;
}



export interface AppDiscountResolution {
  applied: AppliedAppDiscount[];
  /** The snapshot writes of apps whose discounts applied: committed with the order, or the order fails. */
  commits: AppObjectCommit[];
  /** Codes an app discount answered to: not "not found" any more. */
  claimedCodes: string[];
  /** Off the items, all app discounts. */
  merchandiseMinor: number;
  /** Off delivery, all app discounts. */
  shippingMinor: number;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The discount's total on `baseMinor`, by the rounding and cap rules above. */
function discountAmount(
  value: PluginFunctionOutput<"checkout.discounts">["discounts"][number]["value"],
  maxAmountMinor: number | undefined,
  baseMinor: number,
  incrementMinor: number,
): number {
  if (baseMinor <= 0) return 0;
  let amount = value.type === "percentage"
    ? percentOfMinor(baseMinor, Math.min(10_000, Math.max(1, Math.round(value.percent * 100))), incrementMinor)
    : floorToIncrementMinor(value.amountMinor, incrementMinor);
  if (maxAmountMinor !== undefined) amount = Math.min(amount, floorToIncrementMinor(maxAmountMinor, incrementMinor));
  return Math.max(0, Math.min(amount, baseMinor));
}

/**
 * Applies app discounts after the platform's, by the stacking rules at the
 * top of this file. Pure: the same inputs give the same allocation.
 */
export function resolveAppDiscounts(input: {
  currencyCode: string;
  /** The market's price increment: app discounts round to it like the platform's. */
  priceIncrementMinor: number;
  lines: readonly AppDiscountLineInput[];
  /** The delivery charge before any discount. */
  shippingMinor: number;
  /** What the platform already took off delivery. */
  platformShippingDiscountMinor: number;
  /** The codes the buyer entered. */
  submittedCodes: readonly string[];
  results: ReadonlyArray<CheckoutAppFunctionResult<"checkout.discounts">>;
  apps?: Pick<CheckoutAppFunctions, "report">;
}): AppDiscountResolution {
  const submitted = new Set(input.submittedCodes.map(normalizeCode).filter(Boolean));
  const remaining = new Map<string, number>();
  const eligible: string[] = [];
  for (const line of input.lines) {
    const left = Math.max(0, line.grossMinor - Math.min(line.grossMinor, Math.max(0, line.platformDiscountMinor)));
    remaining.set(line.lineId, line.giftCard ? 0 : left);
    if (!line.giftCard) eligible.push(line.lineId);
  }
  let shippingLeft = Math.max(0, input.shippingMinor - Math.min(input.shippingMinor, Math.max(0, input.platformShippingDiscountMinor)));
  const applied: AppliedAppDiscount[] = [];
  const claimed = new Set<string>();

  for (const result of input.results) {
    for (const discount of result.output.discounts) {
      const code = discount.code?.trim() ? normalizeCode(discount.code) : null;
      if (code && !submitted.has(code)) continue;
      const base = {
        pluginId: result.pluginId,
        appName: result.appName,
        title: discount.title,
        code,
        target: discount.target.kind,
      } as const;
      if (discount.target.kind === "shipping") {
        const amount = discountAmount(discount.value, discount.maxAmountMinor, shippingLeft, input.priceIncrementMinor);
        if (code) claimed.add(code);
        if (amount <= 0) continue;
        shippingLeft -= amount;
        applied.push({ ...base, amountMinor: 0, shippingAmountMinor: amount, lines: [] });
        continue;
      }
      let targets: string[];
      if (discount.target.kind === "lines") {
        const unknown = discount.target.lineIds.filter((lineId) => !remaining.has(lineId));
        if (unknown.length > 0) {
          input.apps?.report(result.pluginId, "checkout.discounts", `Discount "${discount.title}" names line ${unknown[0]}, which is not in the cart; it was skipped.`);
          continue;
        }
        targets = [...new Set(discount.target.lineIds)].filter((lineId) => eligible.includes(lineId));
      } else {
        targets = eligible;
      }
      const weights = targets
        .map((lineId) => ({ key: lineId, weightMinor: remaining.get(lineId) ?? 0 }))
        .filter((weight) => weight.weightMinor > 0);
      const baseMinor = weights.reduce((total, weight) => total + weight.weightMinor, 0);
      const amount = discountAmount(discount.value, discount.maxAmountMinor, baseMinor, input.priceIncrementMinor);
      if (code) claimed.add(code);
      if (amount <= 0) continue;
      const split = allocateMinorAmount(amount, weights, input.priceIncrementMinor);
      const lines = weights
        .map((weight) => ({ lineId: weight.key, amountMinor: Math.min(split.get(weight.key) ?? 0, weight.weightMinor) }))
        .filter((line) => line.amountMinor > 0);
      for (const line of lines) remaining.set(line.lineId, (remaining.get(line.lineId) ?? 0) - line.amountMinor);
      const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
      if (total <= 0) continue;
      applied.push({ ...base, amountMinor: total, shippingAmountMinor: 0, lines });
    }
  }
  // An app's write follows its discounts: none applied, nothing is spent.
  const appliedApps = new Set(applied.map((discount) => discount.pluginId));
  return {
    applied,
    commits: input.results.flatMap((result) => (result.commit && appliedApps.has(result.pluginId) ? [result.commit] : [])),
    claimedCodes: [...claimed],
    merchandiseMinor: applied.reduce((total, discount) => total + discount.amountMinor, 0),
    shippingMinor: applied.reduce((total, discount) => total + discount.shippingAmountMinor, 0),
  };
}

/** The platform allocation plus the app discounts, for the tax quote. */
export function combineDiscountAllocations(
  platform: TaxDiscountAllocationInput | undefined,
  apps: readonly AppliedAppDiscount[],
): TaxDiscountAllocationInput | undefined {
  if (apps.length === 0) return platform;
  const lines = new Map<string, number>();
  for (const line of platform?.lines ?? []) lines.set(line.lineId, (lines.get(line.lineId) ?? 0) + line.amountMinor);
  for (const discount of apps) {
    for (const line of discount.lines) lines.set(line.lineId, (lines.get(line.lineId) ?? 0) + line.amountMinor);
  }
  return {
    lines: [...lines].map(([lineId, amountMinor]) => ({ lineId, amountMinor })),
    shippingMinor: (platform?.shippingMinor ?? 0) + apps.reduce((total, discount) => total + discount.shippingAmountMinor, 0),
  };
}

// ── checkout.shipping_rates ─────────────────────────────────────────────────


/**
 * Hide, rename, price and reorder the platform's rates, apps in priority
 * order, each app's operations in order. Apps never add a rate (that is the
 * shipping provider port); an operation on a rate that is not offered is
 * skipped and logged. A hidden rate stays hidden. A price sets the rate's own
 * charge (rounded to the price increment); a rate the platform makes free stays free. Local
 * pickup stays pickup, so cash-on-delivery rules are unchanged.
 */
export function applyAppShippingRateOperations(
  rates: readonly CheckoutRateOption[],
  results: ReadonlyArray<CheckoutAppFunctionResult<"checkout.shipping_rates">>,
  /** The market's price increment an app's price rounds to. */
  incrementMinor: number,
  apps?: Pick<CheckoutAppFunctions, "report">,
): { rates: CheckoutRateOption[]; changed: boolean } {
  let current = rates.map((rate) => ({ ...rate }));
  const known = new Set(rates.map((rate) => rate.rateId));
  const hidden = new Set<string>();
  let changed = false;
  for (const result of results) {
    for (const operation of result.output.operations) {
      const ids = operation.op === "reorder" ? operation.rateIds : [operation.rateId];
      const unknown = ids.find((id) => !known.has(id));
      if (unknown) {
        apps?.report(result.pluginId, "checkout.shipping_rates", `Operation ${operation.op} names rate ${unknown}, which is not offered here; it was skipped.`);
        continue;
      }
      if (operation.op === "hide") {
        if (!hidden.has(operation.rateId)) changed = true;
        hidden.add(operation.rateId);
        continue;
      }
      if (operation.op === "reorder") {
        const order = [...new Set(operation.rateIds)];
        const listed = order.map((id) => current.find((rate) => rate.rateId === id)!).filter(Boolean);
        const rest = current.filter((rate) => !order.includes(rate.rateId));
        const next = [...listed, ...rest];
        if (next.some((rate, position) => rate.rateId !== current[position]?.rateId)) changed = true;
        current = next;
        continue;
      }
      const rate = current.find((candidate) => candidate.rateId === operation.rateId)!;
      if (hidden.has(rate.rateId)) continue;
      if (operation.op === "rename") {
        if (rate.name !== operation.name) changed = true;
        rate.name = operation.name;
      } else {
        const price = roundToIncrementMinor(operation.amountMinor, incrementMinor);
        if (rate.baseAmountMinor !== price) changed = true;
        rate.baseAmountMinor = price;
        rate.amountMinor = rate.waived ? 0 : price;
      }
    }
  }
  return { rates: current.filter((rate) => !hidden.has(rate.rateId)), changed };
}

// ── checkout.payment_methods ────────────────────────────────────────────────

export interface CheckoutPaymentMethodOption {
  methodId: string;
  name: string;
}

/** `details.reason` of the refusal when an app hid the chosen payment method. */
export const PAYMENT_METHOD_UNAVAILABLE_REASON = "payment_method_unavailable";

/**
 * Hide, rename and reorder the methods checkout already allows. Apps never
 * add a method or enable one that is not ready: readiness and the merchant's
 * payment policy decide the list, apps only narrow and present it.
 */
export function applyAppPaymentMethodOperations(
  methods: readonly CheckoutPaymentMethodOption[],
  results: ReadonlyArray<CheckoutAppFunctionResult<"checkout.payment_methods">>,
  apps?: Pick<CheckoutAppFunctions, "report">,
): { methods: CheckoutPaymentMethodOption[]; changed: boolean } {
  let current = methods.map((method) => ({ ...method }));
  const known = new Set(methods.map((method) => method.methodId));
  const hidden = new Set<string>();
  let changed = false;
  for (const result of results) {
    for (const operation of result.output.operations) {
      const ids = operation.op === "reorder" ? operation.methodIds : [operation.methodId];
      const unknown = ids.find((id) => !known.has(id));
      if (unknown) {
        apps?.report(result.pluginId, "checkout.payment_methods", `Operation ${operation.op} names payment method ${unknown}, which is not available here; it was skipped.`);
        continue;
      }
      if (operation.op === "hide") {
        if (!hidden.has(operation.methodId)) changed = true;
        hidden.add(operation.methodId);
      } else if (operation.op === "rename") {
        const method = current.find((candidate) => candidate.methodId === operation.methodId)!;
        if (hidden.has(method.methodId)) continue;
        if (method.name !== operation.name) changed = true;
        method.name = operation.name;
      } else {
        const order = [...new Set(operation.methodIds)];
        const listed = order.map((id) => current.find((method) => method.methodId === id)!).filter(Boolean);
        const next = [...listed, ...current.filter((method) => !order.includes(method.methodId))];
        if (next.some((method, position) => method.methodId !== current[position]?.methodId)) changed = true;
        current = next;
      }
    }
  }
  return { methods: current.filter((method) => !hidden.has(method.methodId)), changed };
}
