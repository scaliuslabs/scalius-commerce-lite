// The payment amount codec (docs/MARKETS-DESIGN.md, D2). Scalius holds money
// as integer minor units of the ISO 4217 exponent; a provider may want
// another wire form (Stripe charges ISK and UGX in two-decimal units, only
// multiples of ten fils for three-decimal currencies; some acquirers take
// IDR without decimals). A provider declares that per currency as data, the
// platform encodes once before it calls the provider, and any rounding the
// wire form forces is reported, recorded with the attempt and never added to
// the charge: the provider is asked for at most what the order owes.

import { z } from "zod";
import { getDecimalPlaces } from "../../currency";

export const providerAmountCodecSchema = z.object({
  /** Decimal places of the provider's wire amount for this currency (default: the ISO exponent). */
  wireExponent: z.number().int().min(0).max(4).optional(),
  /** The provider accepts only multiples of this many ISO minor units (default 1). */
  minorIncrement: z.number().int().min(1).max(10_000).optional(),
}).strict();
export type ProviderAmountCodec = z.infer<typeof providerAmountCodecSchema>;

/** Codecs by ISO 4217 code; a currency without one is sent as is. */
export const providerAmountCodecsSchema = z.record(z.string().regex(/^[A-Z]{3}$/), providerAmountCodecSchema);
export type ProviderAmountCodecs = z.infer<typeof providerAmountCodecsSchema>;

/** One amount as a provider receives it. */
export const providerWireAmountSchema = z.object({
  /** Integer in the provider's wire exponent (Stripe's `amount`). */
  minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** The same amount as a decimal string in that exponent ("150.00"). */
  decimal: z.string().regex(/^\d+(?:\.\d+)?$/),
}).strict();
export type ProviderWireAmount = z.infer<typeof providerWireAmountSchema>;

export interface EncodedProviderAmount {
  currency: string;
  /** What the provider is asked to charge, in ISO minor units. */
  chargedMinor: number;
  /** Requested minus charged (never negative): recorded by the caller, never charged. */
  roundingMinor: number;
  wire: ProviderWireAmount;
}

function decimalString(value: number, places: number): string {
  if (places === 0) return String(value);
  const digits = String(value).padStart(places + 1, "0");
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/**
 * A provider-reported wire amount (Stripe's `amount_received`, a refund's
 * `amount`) back in ISO minor units; null when the wire value is not a whole
 * number of minor units (it is not an amount this codec produced).
 */
export function decodeProviderAmount(
  wireMinor: number,
  currency: string,
  codecs?: ProviderAmountCodecs,
): number | null {
  if (!Number.isSafeInteger(wireMinor) || wireMinor < 0) return null;
  const code = currency.toUpperCase();
  const isoExponent = getDecimalPlaces(code);
  const wireExponent = codecs?.[code]?.wireExponent ?? isoExponent;
  if (wireExponent >= isoExponent) {
    const unit = 10 ** (wireExponent - isoExponent);
    return wireMinor % unit === 0 ? wireMinor / unit : null;
  }
  const minor = wireMinor * 10 ** (isoExponent - wireExponent);
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Encodes an amount for a provider. Rounds down to the provider's increment
 * (and to a whole wire unit when the wire exponent is smaller than ISO's), so
 * the charge never exceeds what was asked.
 */
export function encodeProviderAmount(
  amountMinor: number,
  currency: string,
  codecs?: ProviderAmountCodecs,
): EncodedProviderAmount {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError("Amounts are non-negative integer minor units.");
  const code = currency.toUpperCase();
  const isoExponent = getDecimalPlaces(code);
  const codec = codecs?.[code] ?? {};
  const wireExponent = codec.wireExponent ?? isoExponent;
  const wholeWireUnit = wireExponent < isoExponent ? 10 ** (isoExponent - wireExponent) : 1;
  const increment = Math.max(codec.minorIncrement ?? 1, wholeWireUnit);
  const chargedMinor = amountMinor - (amountMinor % increment);
  const wireMinor = wireExponent >= isoExponent
    ? chargedMinor * 10 ** (wireExponent - isoExponent)
    : chargedMinor / wholeWireUnit;
  if (!Number.isSafeInteger(wireMinor)) throw new RangeError("The wire amount is out of range.");
  return {
    currency: code,
    chargedMinor,
    roundingMinor: amountMinor - chargedMinor,
    wire: { minor: wireMinor, decimal: decimalString(wireMinor, wireExponent) },
  };
}
