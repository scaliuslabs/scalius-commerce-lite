// Discounts on a placed order, the same way on the receipt and the account
// order page: savings on the items are one line per discount, savings on
// delivery sit on the delivery line with the fee struck through.
import { formatDiscountLineLabel } from "@scalius/shared/checkout-language-format";
import type { OrderReceiptDiscount } from "@/lib/api/types";

export interface OrderDiscountSummaryInput {
  /** Each discount used, in major units. */
  discounts: readonly OrderReceiptDiscount[] | null | undefined;
  /** Delivery before any delivery discount. */
  shipping: number;
  /** The delivery method's own fee (before a free-over waiver); `shipping` when unknown. */
  deliveryFee?: number | null;
  /** The order's whole discount, items and delivery. */
  discount: number;
  decimalPlaces?: number | null;
  /** The buyer's word for a discount line: `copy.discountText`. */
  discountText: string;
}

export interface OrderDiscountSummary {
  delivery: {
    /** Shown struck through when more than `charged`. */
    fee: number;
    charged: number;
    /** "R2SJSHIP": the discounts that saved on delivery, or "" for none. */
    codes: string;
  };
  /** "Discount · Eid sale (EID10)" lines, then one plain "Discount" for any unallocated rest. */
  lines: Array<{ label: string; amount: number }>;
}

export function summarizeOrderDiscounts(input: OrderDiscountSummaryInput): OrderDiscountSummary {
  const discounts = input.discounts ?? [];
  const scale = 10 ** Math.max(0, input.decimalPlaces ?? 2);
  const round = (value: number) => Math.round(value * scale) / scale;
  const deliveryDiscounts = discounts.filter(({ shippingAmount }) => shippingAmount > 0);
  const deliverySaved = deliveryDiscounts.reduce((total, { shippingAmount }) => total + shippingAmount, 0);
  const allocated = discounts.reduce((total, { amount, shippingAmount }) => total + amount + shippingAmount, 0);
  // A discount without allocations (a manual order) is one plain line, so the summary adds up.
  const unallocated = Math.max(0, round(input.discount - allocated));
  return {
    delivery: {
      fee: input.deliveryFee ?? input.shipping,
      charged: Math.max(0, round(input.shipping - deliverySaved)),
      codes: deliveryDiscounts.map((line) => line.code ?? line.title).join(", "),
    },
    lines: [
      ...discounts
        .filter(({ amount }) => amount > 0)
        .map((line) => ({ label: formatDiscountLineLabel(input.discountText, line), amount: line.amount })),
      ...(unallocated > 0 ? [{ label: input.discountText, amount: unallocated }] : []),
    ],
  };
}
