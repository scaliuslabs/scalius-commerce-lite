/**
 * The zod-free part of the checkout quote contract: the value checks, the
 * discount lines, offers and code statuses, and the quoted delivery options.
 * The cart drawer reads only these, so it loads neither the full quote
 * contract nor the buyer UI schemas (zod) that contract parses with.
 * `tax-quote-contract.ts` re-exports everything here.
 */
import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";

export const TAX_QUOTE_MAX_ITEMS = 99;
export const MAX_ID_LENGTH = 180;
export const MAX_NAME_LENGTH = 200;
export const MAX_CODE_LENGTH = 50;
/** Mirrors the API's `MAX_SUBMITTED_DISCOUNT_CODES`. */
export const MAX_DISCOUNT_CODES = 5;
export const MAX_SHIPPING_METHOD_NAME_LENGTH = 100;
const MAX_QUANTITY = MAX_LINE_QUANTITY;
const MAX_MAJOR_AMOUNT = 1_000_000_000_000;

/**
 * One line per applied discount (automatic by title, codes with their code).
 * A discount a store app gave has no promotion: `promotionId` is null and
 * `appId` names the app (present only then).
 */
export interface CheckoutDiscountLine {
  promotionId: string | null;
  appId?: string | null;
  title: string;
  code: string | null;
  /** Off the items: a discount line. */
  amount: number;
  /** Off delivery: shown on the delivery line, never as a discount line. */
  shippingAmount: number;
  /** A code only: the automatic discount it replaced (it saves more; they can't be combined). */
  replaces?: string;
}

/**
 * A stable identity for a discount line in a rendered list: its promotion, or
 * for an app's discount the app and the line's position in the quote.
 */
export function discountLineKey(
  line: Pick<CheckoutDiscountLine, "promotionId" | "appId">,
  position: number,
): string {
  return line.promotionId ?? `app:${line.appId ?? ""}:${position}`;
}

/**
 * A delivery or pickup option as a store app left it on this quote: shown in
 * this order, with this name and this fee (what the buyer pays, platform
 * free-delivery waivers already applied).
 */
export interface QuotedShippingRate {
  id: string;
  name: string;
  kind: "delivery" | "pickup";
  amount: number;
  amountMinor: number;
}

export interface CheckoutOfferProduct {
  id: string;
  slug: string;
  name: string;
  /** Set for simple products: they can be added in one tap. */
  variantId: string | null;
  price: number | null;
}

/** A Buy X get Y the buyer completes by adding items. */
export interface CheckoutDiscountOffer {
  promotionId: string;
  title: string;
  code: string | null;
  kind: "get" | "buy";
  percentOff: number;
  quantity: number;
  shortfallAmount: number | null;
  products: CheckoutOfferProduct[];
}

export type CheckoutRejectedCodeReason =
  | "not_found"
  | "needs_phone"
  | "minimum_subtotal"
  | "minimum_quantity"
  | "get_items"
  | "buy_items"
  | "not_combinable"
  | "lower_savings"
  | "needs_delivery"
  | "delivery_discount_applied"
  | "unavailable";

/** An applied code that adds nothing right now, with why and what to do. */
export interface CheckoutRejectedCode {
  code: string;
  reason: CheckoutRejectedCodeReason;
  message: string;
  shortfallAmount?: number;
  shortfallQuantity?: number;
  conflictsWith?: string;
  offer?: CheckoutDiscountOffer;
  requiresCustomerPhone?: boolean;
  /** The code applies, but the quantity-bundle saving is bigger, so the bundle is used. */
  bundleSavesMore?: true;
}

export interface CheckoutDiscountFacts {
  discounts: CheckoutDiscountLine[];
  /** Automatic Buy X get Y the buyer earned: the items to get are not in the cart yet. */
  offers: CheckoutDiscountOffer[];
  rejectedCodes: CheckoutRejectedCode[];
}

export class TaxQuoteContractError extends Error {
  constructor() {
    super("The checkout total response did not match the expected contract.");
    this.name = "TaxQuoteContractError";
  }
}

export function fail(): never {
  throw new TaxQuoteContractError();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") fail();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    hasControlCharacter(normalized)
  ) {
    fail();
  }
  return normalized;
}

export function positiveQuantity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_QUANTITY
  ) {
    fail();
  }
  return value;
}

export function nonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail();
  }
  return value;
}

export function nonNegativeAmount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_MAJOR_AMOUNT
  ) {
    fail();
  }
  return value;
}

export function assertAmountMatchesMinor(
  amount: number,
  minor: number,
  decimalPlaces: number,
): void {
  const factor = 10 ** decimalPlaces;
  if (Math.round(amount * factor) !== minor) fail();
}

function parseQuotedRateKind(value: unknown): QuotedShippingRate["kind"] {
  return value === "delivery" || value === "pickup" ? value : fail();
}

/** One quoted delivery option; amounts are checked against their minor units when the scale is known. */
export function parseQuotedShippingRate(
  value: unknown,
  decimalPlaces: number | null,
): QuotedShippingRate {
  if (!isRecord(value)) fail();
  const amount = nonNegativeAmount(value.amount);
  const amountMinor = nonNegativeSafeInteger(value.amountMinor);
  if (decimalPlaces !== null) assertAmountMatchesMinor(amount, amountMinor, decimalPlaces);
  return {
    id: requiredString(value.id, MAX_ID_LENGTH),
    name: requiredString(value.name, MAX_SHIPPING_METHOD_NAME_LENGTH),
    kind: parseQuotedRateKind(value.kind),
    amount,
    amountMinor,
  };
}

function parseOffer(value: unknown): CheckoutDiscountOffer {
  if (!isRecord(value) || (value.kind !== "get" && value.kind !== "buy")) fail();
  if (!Array.isArray(value.products) || value.products.length > 3) fail();
  return {
    promotionId: requiredString(value.promotionId, MAX_ID_LENGTH),
    title: requiredString(value.title, 160),
    code: value.code === null ? null : requiredString(value.code, MAX_CODE_LENGTH),
    kind: value.kind,
    percentOff: nonNegativeAmount(value.percentOff),
    quantity: positiveQuantity(Math.min(Number(value.quantity), MAX_QUANTITY)),
    shortfallAmount: value.shortfallAmount === null ? null : nonNegativeAmount(value.shortfallAmount),
    products: value.products.map((product) => {
      if (!isRecord(product)) fail();
      return {
        id: requiredString(product.id, MAX_ID_LENGTH),
        slug: requiredString(product.slug, MAX_ID_LENGTH),
        name: requiredString(product.name, MAX_NAME_LENGTH),
        variantId: product.variantId === null ? null : requiredString(product.variantId, MAX_ID_LENGTH),
        price: product.price === null ? null : nonNegativeAmount(product.price),
      };
    }),
  };
}

/** Stands in for a promotion id on the quantity-bundle discount line. */
export const BUNDLE_DISCOUNT_LINE_ID = "bundle";

export function bundleDiscountLine(bundles: unknown, amount: number): CheckoutDiscountLine {
  bundles ??= [];
  if (!Array.isArray(bundles) || bundles.length > TAX_QUOTE_MAX_ITEMS) fail();
  const labels = [...new Set(bundles.flatMap((bundle) =>
    isRecord(bundle) && typeof bundle.label === "string" && bundle.label.trim()
      ? [requiredString(bundle.label, 60)]
      : []))];
  return {
    promotionId: BUNDLE_DISCOUNT_LINE_ID,
    title: labels.join(", "),
    code: null,
    amount,
    shippingAmount: 0,
  };
}

/**
 * The cart preview's (`/discounts/validate`) quantity-bundle saving as the
 * same "Discount · Pair" line the tax quote shows, or null when none applies
 * (or the API predates bundle previews).
 */
export function parsePreviewBundleDiscountLine(data: Record<string, unknown>): CheckoutDiscountLine | null {
  if (data.bundleDiscountAmount === undefined || data.bundleDiscountAmount === null) return null;
  const amount = nonNegativeAmount(data.bundleDiscountAmount);
  return amount > 0 ? bundleDiscountLine(data.bundles, amount) : null;
}

const REJECTED_CODE_REASONS = new Set<CheckoutRejectedCodeReason>([
  "not_found", "needs_phone", "minimum_subtotal", "minimum_quantity",
  "get_items", "buy_items", "not_combinable", "lower_savings", "needs_delivery",
  "delivery_discount_applied", "unavailable",
]);

/** The discount lines, offers and code statuses shared by the tax quote and the cart preview. */
export function parseDiscountFacts(data: Record<string, unknown>): CheckoutDiscountFacts {
  const { discounts = [], offers = [], rejectedCodes = [] } = data;
  if (!Array.isArray(discounts) || discounts.length > 10) fail();
  if (!Array.isArray(offers) || offers.length > 3) fail();
  if (!Array.isArray(rejectedCodes) || rejectedCodes.length > MAX_DISCOUNT_CODES) fail();
  return {
    discounts: discounts.map((line) => {
      if (!isRecord(line)) fail();
      // A promotion's line, or (promotion null) a line a store app gave.
      const promotionId = line.promotionId === null ? null : requiredString(line.promotionId, MAX_ID_LENGTH);
      const appId = line.appId === undefined || line.appId === null ? null : requiredString(line.appId, MAX_ID_LENGTH);
      if (promotionId === null && appId === null) fail();
      return {
        promotionId,
        ...(appId !== null ? { appId } : {}),
        title: requiredString(line.title, 160),
        code: line.code === null ? null : requiredString(line.code, MAX_CODE_LENGTH),
        amount: nonNegativeAmount(line.amount),
        shippingAmount: nonNegativeAmount(line.shippingAmount),
        ...(line.replaces === undefined ? {} : { replaces: requiredString(line.replaces, 160) }),
      };
    }),
    offers: offers.map(parseOffer),
    rejectedCodes: rejectedCodes.map((rejection) => {
      if (!isRecord(rejection) || !REJECTED_CODE_REASONS.has(rejection.reason as CheckoutRejectedCodeReason)) fail();
      return {
        code: requiredString(rejection.code, MAX_CODE_LENGTH),
        reason: rejection.reason as CheckoutRejectedCodeReason,
        message: requiredString(rejection.message, 300),
        ...(typeof rejection.shortfallAmount === "number" ? { shortfallAmount: nonNegativeAmount(rejection.shortfallAmount) } : {}),
        ...(typeof rejection.shortfallQuantity === "number" ? { shortfallQuantity: positiveQuantity(Math.min(rejection.shortfallQuantity, MAX_QUANTITY)) } : {}),
        ...(typeof rejection.conflictsWith === "string" ? { conflictsWith: requiredString(rejection.conflictsWith, 160) } : {}),
        ...(rejection.offer !== undefined ? { offer: parseOffer(rejection.offer) } : {}),
        ...(rejection.requiresCustomerPhone === true ? { requiresCustomerPhone: true } : {}),
        ...(rejection.bundleSavesMore === true ? { bundleSavesMore: true as const } : {}),
      };
    }),
  };
}
