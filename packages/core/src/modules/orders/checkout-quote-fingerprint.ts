import { AppError } from "@scalius/core/errors";
import type { TaxQuote } from "@scalius/core/modules/tax";
import type { StorefrontOrderShippingMethodSnapshot } from "./orders.types";

export const STOREFRONT_CHECKOUT_QUOTE_FINGERPRINT_PATTERN =
  /^taxq_[A-Za-z0-9_-]{22}$/;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Hash only the authoritative buyer-visible facts that define the reviewed
 * checkout total. Presentation labels and internal tax allocation details do
 * not invalidate an otherwise identical quote.
 */
export async function buildStorefrontCheckoutQuoteFingerprint(
  quote: TaxQuote,
  shippingMethod: StorefrontOrderShippingMethodSnapshot,
): Promise<string> {
  const identity = {
    calculationVersion: quote.calculationVersion,
    settingsVersion: quote.settingsVersion,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    destination: quote.destination,
    subtotalMinor: quote.subtotalMinor,
    shippingMinor: quote.shippingMinor,
    discountMinor: quote.discountMinor,
    taxMinor: quote.taxMinor,
    totalMinor: quote.totalMinor,
    shippingMethod: [
      shippingMethod.id,
      shippingMethod.name,
      shippingMethod.description,
      shippingMethod.baseAmountMinor,
      shippingMethod.feeWaived,
    ],
    lines: quote.lines.map((line) => [
      line.productId,
      line.variantId,
      line.quantity,
      line.unitPriceMinor,
    ]),
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(identity)),
  );
  return `taxq_${encodeBase64Url(new Uint8Array(digest)).slice(0, 22)}`;
}

export class StorefrontCheckoutQuoteConflictError extends AppError {
  constructor() {
    super(
      409,
      "STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
      "Your order total or checkout terms changed. Review the refreshed total and confirm the order again.",
    );
    this.name = "StorefrontCheckoutQuoteConflictError";
  }
}

export function assertStorefrontCheckoutQuoteFingerprint(
  expectedQuoteFingerprint: string,
  currentQuoteFingerprint: string,
): void {
  if (expectedQuoteFingerprint !== currentQuoteFingerprint) {
    throw new StorefrontCheckoutQuoteConflictError();
  }
}
