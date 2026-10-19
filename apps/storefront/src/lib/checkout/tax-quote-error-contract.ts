import type { CartRuleError, CartValidationIssue } from "../api/orders";
import { parseQuotedShippingRate, type QuotedShippingRate } from "./tax-quote-contract";

// Every code and action the API answers with (a Record, so a new one fails to
// compile here): an issue this list does not know would read as an outage.
const ISSUE_CODES = new Set(Object.keys({
  PRODUCT_UNAVAILABLE: true,
  VARIANT_REQUIRED: true,
  VARIANT_UNAVAILABLE: true,
  VARIANT_MISMATCH: true,
  QUANTITY_UNAVAILABLE: true,
  PRICE_CHANGED: true,
  PROPERTIES_REQUIRED: true,
  PROPERTIES_INVALID: true,
  FULFILMENT_UNAVAILABLE: true,
} satisfies Record<CartValidationIssue["code"], true>));
const ISSUE_ACTIONS = new Set(Object.keys({
  remove: true,
  select_variant: true,
  reduce_quantity: true,
  refresh_item: true,
  edit_properties: true,
} satisfies Record<CartValidationIssue["action"], true>));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function issueDetails(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.error) && isRecord(payload.error.details)) {
    return payload.error.details;
  }
  return isRecord(payload.details) ? payload.details : null;
}

export function parseTaxQuoteCartIssues(payload: unknown): CartValidationIssue[] {
  const rawIssues = issueDetails(payload)?.itemIssues;
  if (!Array.isArray(rawIssues)) return [];

  return rawIssues.slice(0, 99).flatMap((value): CartValidationIssue[] => {
    if (!isRecord(value)) return [];
    const index = value.index;
    const productId = boundedString(value.productId, 180);
    const code = value.code;
    const action = value.action;
    const message = boundedString(value.message, 300);
    const requestedQuantity = value.requestedQuantity;
    if (
      typeof index !== "number"
      || !Number.isSafeInteger(index)
      || index < 0
      || !productId
      || !ISSUE_CODES.has(code as CartValidationIssue["code"])
      || !ISSUE_ACTIONS.has(action as CartValidationIssue["action"])
      || !message
      || typeof requestedQuantity !== "number"
      || !Number.isSafeInteger(requestedQuantity)
      || requestedQuantity < 1
      || requestedQuantity > 99
    ) {
      return [];
    }

    const cartKey = boundedString(value.cartKey, 256);
    const variantId = boundedString(value.variantId, 180);
    const productName = boundedString(value.productName, 200);
    const variantLabel = boundedString(value.variantLabel, 200);
    return [{
      index,
      ...(cartKey ? { cartKey } : {}),
      productId,
      variantId,
      code: code as CartValidationIssue["code"],
      action: action as CartValidationIssue["action"],
      message,
      productName,
      variantLabel,
      requestedQuantity,
      ...(optionalFiniteNumber(value.availableQuantity) !== undefined
        ? { availableQuantity: optionalFiniteNumber(value.availableQuantity) }
        : {}),
      ...(optionalFiniteNumber(value.submittedPrice) !== undefined
        ? { submittedPrice: optionalFiniteNumber(value.submittedPrice) }
        : {}),
      ...(optionalFiniteNumber(value.currentPrice) !== undefined
        ? { currentPrice: optionalFiniteNumber(value.currentPrice) }
        : {}),
      ...(boundedString(value.propertyKey, 40) ? { propertyKey: boundedString(value.propertyKey, 40) } : {}),
    }];
  });
}

/** Mirrors core `DELIVERY_LOCATION_UNAVAILABLE_REASON`. */
export const DELIVERY_LOCATION_UNAVAILABLE_REASON = "delivery_location_unavailable";

export type DeliveryLocationLevel = "city" | "zone" | "area";

/**
 * The city, thana or area the buyer chose is gone (the merchant removed it):
 * the level to clear and ask again, or null for any other answer.
 */
export function unavailableDeliveryLocation(payload: unknown): DeliveryLocationLevel | null {
  const details = issueDetails(payload);
  if (details?.reason !== DELIVERY_LOCATION_UNAVAILABLE_REASON) return null;
  return details.field === "city" || details.field === "zone" || details.field === "area" ? details.field : null;
}

/** Mirrors core `DELIVERY_RATE_UNAVAILABLE_REASON`. */
export const DELIVERY_RATE_UNAVAILABLE_REASON = "delivery_rate_unavailable";

/**
 * The checkout refused the chosen delivery rate (gone, or not offered for the
 * address): the cart re-reads the address's rates rather than reporting an
 * unavailable total.
 */
export function isDeliveryRateUnavailable(payload: unknown): boolean {
  return issueDetails(payload)?.reason === DELIVERY_RATE_UNAVAILABLE_REASON;
}

/**
 * The visible delivery options a refusal of the chosen one names (a store app
 * hid it), or null when it names none (the rate is gone: re-read the rates).
 */
export function refusedDeliveryRates(payload: unknown): QuotedShippingRate[] | null {
  const details = issueDetails(payload);
  if (details?.reason !== DELIVERY_RATE_UNAVAILABLE_REASON || !Array.isArray(details.shippingRates)) return null;
  if (details.shippingRates.length > 100) return null;
  try {
    // An error carries no currency scale: amounts are only checked as amounts.
    const rates = details.shippingRates.map((rate) => parseQuotedShippingRate(rate, null));
    return new Set(rates.map(({ id }) => id)).size === rates.length ? rates : null;
  } catch {
    return null;
  }
}

/** Mirrors the API's checkout-function refusal reasons. */
export const CART_RULES_REASON = "cart_rules";
export const PAYMENT_METHOD_UNAVAILABLE_REASON = "payment_method_unavailable";

const MAX_CART_RULE_ERRORS = 50;
const MAX_CART_RULE_MESSAGE_LENGTH = 300;

/** A store app's buyer-facing text as one line of plain text (control characters become spaces). */
function ruleText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

/**
 * Store app rules that block checkout, bounded: an entry without a usable
 * message is dropped, a line reference that is not one becomes the whole cart.
 */
export function parseCartRuleErrors(value: unknown): CartRuleError[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CART_RULE_ERRORS).flatMap((entry): CartRuleError[] => {
    if (!isRecord(entry)) return [];
    const message = ruleText(entry.message, MAX_CART_RULE_MESSAGE_LENGTH);
    if (!message) return [];
    const index = typeof entry.index === "number" && Number.isSafeInteger(entry.index) && entry.index >= 0
      ? entry.index
      : null;
    return [{
      code: boundedString(entry.code, 100) ?? "rule",
      message,
      index,
      cartKey: boundedString(entry.cartKey, 256),
    }];
  });
}

/**
 * The rules a refusal names (`details.reason = "cart_rules"`), or null for any
 * other answer. A rules refusal whose entries are unreadable still blocks: it
 * becomes one whole-cart entry with no text of its own.
 */
export function cartRuleRefusal(payload: unknown): CartRuleError[] | null {
  const details = issueDetails(payload);
  if (details?.reason !== CART_RULES_REASON) return null;
  const ruleErrors = parseCartRuleErrors(details.ruleErrors);
  return ruleErrors.length > 0
    ? ruleErrors
    : [{ code: CART_RULES_REASON, message: "", index: null, cartKey: null }];
}

/** The order refused the chosen payment method (a store app hid it for this order). */
export function isPaymentMethodUnavailable(payload: unknown): boolean {
  return issueDetails(payload)?.reason === PAYMENT_METHOD_UNAVAILABLE_REASON;
}

/** Why the order was refused, when it is a reason the checkout repairs itself. */
export type CheckoutOrderRefusal =
  | { reason: typeof CART_RULES_REASON; ruleErrors: CartRuleError[] }
  | { reason: typeof PAYMENT_METHOD_UNAVAILABLE_REASON }
  | { reason: typeof DELIVERY_RATE_UNAVAILABLE_REASON; shippingRates: QuotedShippingRate[] | null };

export function checkoutOrderRefusal(payload: unknown): CheckoutOrderRefusal | null {
  const ruleErrors = cartRuleRefusal(payload);
  if (ruleErrors) return { reason: CART_RULES_REASON, ruleErrors };
  if (isPaymentMethodUnavailable(payload)) return { reason: PAYMENT_METHOD_UNAVAILABLE_REASON };
  if (isDeliveryRateUnavailable(payload)) {
    return { reason: DELIVERY_RATE_UNAVAILABLE_REASON, shippingRates: refusedDeliveryRates(payload) };
  }
  return null;
}
