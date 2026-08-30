import { AppError } from "@scalius/core/errors";
import type { TaxQuote } from "@scalius/core/modules/tax";

export const AGENT_STOREFRONT_CHECKOUT_QUOTE_FINGERPRINT_PATTERN = /^taxq_[A-Za-z0-9_-]{22}$/;

export interface AgentStorefrontCheckoutQuoteFingerprintInput {
  contextRevision: number;
  shippingMethodId: string;
  discountCode: string | null;
  quote: TaxQuote;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function buildAgentStorefrontCheckoutQuoteFingerprint(
  input: AgentStorefrontCheckoutQuoteFingerprintInput,
): Promise<string> {
  const identity = {
    contextRevision: input.contextRevision,
    shippingMethodId: input.shippingMethodId,
    discountCode: input.discountCode?.trim().toUpperCase() ?? null,
    calculationVersion: input.quote.calculationVersion,
    settingsVersion: input.quote.settingsVersion,
    currencyCode: input.quote.currencyCode,
    destination: input.quote.destination,
    subtotalMinor: input.quote.subtotalMinor,
    shippingMinor: input.quote.shippingMinor,
    discountMinor: input.quote.discountMinor,
    taxMinor: input.quote.taxMinor,
    totalMinor: input.quote.totalMinor,
    lines: input.quote.lines.map((line) => [
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

export class AgentStorefrontCheckoutQuoteConflictError extends AppError {
  constructor() {
    super(
      409,
      "AGENT_STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
      "Checkout totals or terms changed after review. Request a fresh quote and confirm it before submitting again.",
    );
    this.name = "AgentStorefrontCheckoutQuoteConflictError";
  }
}

export function assertAgentStorefrontCheckoutQuoteFingerprint(
  expectedQuoteFingerprint: string,
  currentQuoteFingerprint: string,
): void {
  if (expectedQuoteFingerprint !== currentQuoteFingerprint) {
    throw new AgentStorefrontCheckoutQuoteConflictError();
  }
}
