import { typedMinor } from "~/lib/typed-money";

/**
 * The delivery charge and discount staff typed, in major units, as the API
 * takes them: integer minor units of the currency the order is in (a new
 * order's is the store's; an amended order keeps its own, possibly a
 * market's). The one conversion, at the dashboard's edge.
 */
export function orderMoneyInput(
  values: { shippingCharge: number; discountAmount?: number | null },
  currencyCode: string,
): { shippingMinor: number; discountMinor: number | null } {
  return {
    shippingMinor: typedMinor(values.shippingCharge, currencyCode),
    discountMinor: values.discountAmount == null ? null : typedMinor(values.discountAmount, currencyCode),
  };
}
