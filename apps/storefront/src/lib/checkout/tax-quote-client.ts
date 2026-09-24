import {
  normalizeTaxQuoteRequest,
  parseTaxQuoteEnvelope,
  TaxQuoteContractError,
  type CheckoutTaxQuote,
  type TaxQuoteRequest,
} from "./tax-quote-contract";
import { cartItemVariantLabel } from "../cart/item-options";
import type { CartValidationIssue } from "../api/orders";
import { isDeliveryRateUnavailable, parseTaxQuoteCartIssues } from "./tax-quote-error-contract";

const TAX_QUOTE_ENDPOINT = "/api/checkout/tax-quote";
const TAX_QUOTE_TIMEOUT_MS = 10_000;

type CheckoutCartLine = {
  id?: unknown;
  variantId?: unknown;
  quantity?: unknown;
  name?: unknown;
  options?: unknown;
};

export class TaxQuoteUnavailableError extends Error {
  constructor() {
    super(
      "We could not verify the current taxes and order total. Please return to your cart and try again.",
    );
    this.name = "TaxQuoteUnavailableError";
  }
}

export class TaxQuoteCartChangedError extends Error {
  constructor(public readonly issues: CartValidationIssue[]) {
    super(
      issues.length === 1
        ? "One cart item changed before payment."
        : `${issues.length} cart items changed before payment.`,
    );
    this.name = "TaxQuoteCartChangedError";
  }
}

/** The chosen delivery rate no longer serves the address: re-read the rates. */
export class TaxQuoteDeliveryRateError extends Error {
  constructor() {
    super("The chosen delivery option isn't available for this address.");
    this.name = "TaxQuoteDeliveryRateError";
  }
}

function readCartItems(value: unknown): Record<string, CheckoutCartLine> {
  if (typeof value !== "string") throw new TaxQuoteUnavailableError();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TaxQuoteUnavailableError();
    }
    return parsed as Record<string, CheckoutCartLine>;
  } catch {
    throw new TaxQuoteUnavailableError();
  }
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

/**
 * The applied discount codes: the cart and checkout transfer carry them as a
 * JSON array string (`discountCodes`); the quote re-checks every one.
 */
export function readDiscountCodes(data: Record<string, unknown>): string[] {
  let value = data.discountCodes;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.flatMap((code) => {
        const clean = cleanOptionalText(code, 50);
        return clean ? [clean.toUpperCase()] : [];
      })
    : [];
}

function variantLabel(item: CheckoutCartLine): string | undefined {
  return cartItemVariantLabel(item.options) ?? undefined;
}

export function buildTaxQuoteRequest(
  data: Record<string, unknown>,
): TaxQuoteRequest {
  const cartItems = readCartItems(data.cartItems);
  const items = Object.entries(cartItems).map(([cartKey, item]) => ({
    cartKey,
    productId: item.id,
    variantId: item.variantId,
    quantity: item.quantity,
    productName: cleanOptionalText(item.name, 200),
    variantLabel: variantLabel(item),
  }));

  try {
    return normalizeTaxQuoteRequest({
      items,
      inventoryPool: data.inventoryPool,
      city: data.city,
      zone: data.zone,
      area: data.area,
      shippingMethodId: data.shippingMethodId,
      discountCodes: readDiscountCodes(data),
      customerPhone: data.customerPhone,
    });
  } catch {
    throw new TaxQuoteUnavailableError();
  }
}

export async function fetchAuthoritativeTaxQuote(
  data: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<CheckoutTaxQuote> {
  const request = buildTaxQuoteRequest(data);

  try {
    const response = await fetcher(TAX_QUOTE_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(TAX_QUOTE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const issues = parseTaxQuoteCartIssues(payload);
      if (issues.length > 0) throw new TaxQuoteCartChangedError(issues);
      if (isDeliveryRateUnavailable(payload)) throw new TaxQuoteDeliveryRateError();
      throw new TaxQuoteUnavailableError();
    }
    const quote = parseTaxQuoteEnvelope(await response.json());
    if (quote.shippingMethod.id !== request.shippingMethodId) {
      throw new TaxQuoteUnavailableError();
    }
    if (quote.items.length !== request.items.length) {
      throw new TaxQuoteUnavailableError();
    }
    const requestItemsByCartKey = new Map(
      request.items.map((item) => [item.cartKey, item]),
    );
    for (const item of quote.items) {
      const submitted = requestItemsByCartKey.get(item.cartKey);
      if (
        !submitted ||
        submitted.productId !== item.productId ||
        submitted.variantId !== item.variantId ||
        submitted.quantity !== item.quantity
      ) {
        throw new TaxQuoteUnavailableError();
      }
    }
    return quote;
  } catch (error) {
    if (error instanceof TaxQuoteCartChangedError) throw error;
    if (error instanceof TaxQuoteDeliveryRateError) throw error;
    if (error instanceof TaxQuoteUnavailableError) throw error;
    if (error instanceof TaxQuoteContractError) throw new TaxQuoteUnavailableError();
    throw new TaxQuoteUnavailableError();
  }
}
