// Where a placed order's discount is shown, the same on the receipt and the
// account order page, so each saving appears once:
// - an order-level promotion ("10% off the order") is one line in the totals,
//   and each item keeps its full price;
// - an item-level saving (a product or buy-x-get-y promotion, or a line
//   saving with no promotion behind it, like a quantity bundle or a manual
//   order's discount) is shown on its item, and in the totals.

export interface OrderDiscountKind {
  kind: string;
  /** Off the items, in major units. */
  amount: number;
}

/** False when an order-level promotion priced the order: its share on each line is not the item's own saving. */
export function orderShowsLineDiscounts(discounts: readonly OrderDiscountKind[] | null | undefined): boolean {
  return !(discounts ?? []).some(({ kind, amount }) => kind === "order" && amount > 0);
}

export interface SavedLineAmounts {
  grossSubtotalMinor: number;
  discountMinor: number;
}

/**
 * The line total a buyer reads: quantity × the unit price shown beside it,
 * after its own saving (at full price when the saving is the order's). Tax
 * is never folded into a line: the line is in the market's prices (tax
 * included when its prices include tax), and the tax is its own row in the
 * totals, on the receipt and the account order alike (Shopify's order page).
 */
export function presentedLineTotalMinor(
  line: SavedLineAmounts,
  showsLineDiscount: boolean,
): number {
  return line.grossSubtotalMinor - (showsLineDiscount ? line.discountMinor : 0);
}
