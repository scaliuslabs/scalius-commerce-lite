import type { OrderItem } from "./types";

/** The lines a refund can name: everything but gift cards, which the refund dialog never lists. */
export function refundableLines(items: readonly OrderItem[]): OrderItem[] {
  return items.filter((item) => item.fulfillmentType !== "gift_card" && item.quantity > 0);
}

/**
 * The `lines` body field of a refund: the lines with a quantity above zero,
 * each capped at what was ordered. Undefined (field omitted) when none is
 * named; the amount is the money and never depends on the lines.
 */
export function refundLinesBody(
  items: readonly OrderItem[],
  quantities: Readonly<Record<string, number>>,
): Array<{ orderItemId: string; quantity: number }> | undefined {
  const lines = refundableLines(items)
    .map((item) => ({ orderItemId: item.id, quantity: Math.min(item.quantity, Math.trunc(quantities[item.id] ?? 0)) }))
    .filter((line) => line.quantity > 0)
    .slice(0, 250);
  return lines.length > 0 ? lines : undefined;
}
