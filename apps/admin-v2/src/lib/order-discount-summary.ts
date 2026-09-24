import { discountDisplayName } from "@scalius/shared/checkout-language-format";

/**
 * How an order summary shows its discounts (brief decision 4), in minor units
 * so the lines add up exactly: savings on delivery sit on the delivery line
 * ("~~৳80~~ Free (CODE)" or the reduced fee), savings on the items are one
 * "Discount · Title (CODE)" line each, and a discount with no promotion behind
 * it (a manual order) is one plain "Discount" line.
 *
 * subtotal + delivery charged − item discounts − manual discount (+ tax when
 * added on top) = order total.
 */
export interface SummaryDiscountInput {
  promotionId?: string;
  name: string;
  code: string | null;
  /** Everything the discount saved, items and delivery (major units). */
  amount: number;
  /** The part off delivery (major units); absent on older invoices. */
  shippingAmount?: number;
}

export interface ItemDiscountLine<T extends SummaryDiscountInput> {
  discount: T;
  /** "Title (CODE)", or the one of them there is. */
  name: string;
  amountMinor: number;
}

export interface OrderDiscountSummary<T extends SummaryDiscountInput> {
  /** What the customer pays for delivery. */
  deliveryChargedMinor: number;
  /** The fee before savings, shown struck through; null when nothing came off. */
  deliveryStruckMinor: number | null;
  /** Codes (or titles) of the discounts that lowered delivery. */
  deliveryDiscountNames: string[];
  itemDiscounts: ItemDiscountLine<T>[];
  /** A discount not tied to any promotion, e.g. typed on a manual order. */
  otherDiscountMinor: number;
}


export function summarizeOrderDiscounts<T extends SummaryDiscountInput>(input: {
  discounts: readonly T[];
  /** The delivery fee before any saving (the order's shipping amount). */
  shippingMinor: number;
  /** Every saving on the order, items and delivery. */
  discountMinor: number;
  decimalPlaces: number;
  /** A legacy waived fee: the method's fee when the order charged nothing for delivery. */
  waivedFeeMinor?: number | null;
}): OrderDiscountSummary<T> {
  const toMinor = (major: number | undefined) => Math.round((major ?? 0) * 10 ** input.decimalPlaces);
  const deliveryDiscounts = input.discounts.filter((discount) => toMinor(discount.shippingAmount) > 0);
  const deliverySavedMinor = Math.min(
    input.shippingMinor,
    deliveryDiscounts.reduce((sum, discount) => sum + toMinor(discount.shippingAmount), 0),
  );
  const itemDiscounts = input.discounts
    .map((discount) => ({
      discount,
      name: discountDisplayName({ title: discount.name, code: discount.code }),
      amountMinor: toMinor(discount.amount) - toMinor(discount.shippingAmount),
    }))
    .filter((line) => line.amountMinor > 0);
  const promotionMinor = input.discounts.reduce((sum, discount) => sum + toMinor(discount.amount), 0);
  const waivedFee = deliveryDiscounts.length === 0 && input.shippingMinor === 0 && (input.waivedFeeMinor ?? 0) > 0
    ? input.waivedFeeMinor!
    : null;
  return {
    deliveryChargedMinor: input.shippingMinor - deliverySavedMinor,
    deliveryStruckMinor: deliverySavedMinor > 0 ? input.shippingMinor : waivedFee,
    deliveryDiscountNames: deliveryDiscounts.map((discount) => discount.code?.trim() || discount.name.trim()).filter(Boolean),
    itemDiscounts,
    otherDiscountMinor: Math.max(0, input.discountMinor - promotionMinor),
  };
}
