// A line's unit price with its buyer inputs' surcharges, shared by the
// product page's script and the no-JavaScript `/buy/<slug>` POST. Kept apart
// from buyer-inputs.ts so a product page without buyer inputs loads only
// this, never the inputs' checks.
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";

/** Currency places the money helpers accept (0–3), else the currency's own. */
export function moneyPlaces(decimalPlaces: number | null | undefined, currencyCode: string): number {
  return Number.isInteger(decimalPlaces) && decimalPlaces! >= 0 && decimalPlaces! <= 3
    ? decimalPlaces!
    : getDecimalPlaces(currencyCode);
}

/**
 * One unit with its inputs: the base (the SKU's sale price, the product's own
 * discount applied to the base only) plus the surcharges, in exact minor units.
 */
export function unitPriceWithSurcharge(basePrice: number, surchargeMinor: number, places: number): number {
  if (!(surchargeMinor > 0)) return basePrice;
  try {
    return fromMinor(toMinor(Math.max(0, basePrice), places) + surchargeMinor, places);
  } catch {
    return basePrice;
  }
}
