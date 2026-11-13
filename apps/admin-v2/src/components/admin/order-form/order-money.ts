import { toMinor } from "@scalius/shared/money";

/**
 * The delivery charge and discount staff typed, in major units, as the API
 * takes them: integer minor units at the currency's exponent (0 for JPY, 2
 * for BDT, 3 for KWD). The one conversion, at the dashboard's edge.
 */
export function orderMoneyInput(
  values: { shippingCharge: number; discountAmount?: number | null },
  decimalPlaces: number,
): { shippingMinor: number; discountMinor: number | null } {
  return {
    shippingMinor: toMinor(values.shippingCharge, decimalPlaces),
    discountMinor: values.discountAmount == null ? null : toMinor(values.discountAmount, decimalPlaces),
  };
}
