import type { OrderReturnDto } from "~/lib/order-return-workflow";
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

/**
 * The lines a first refund of returned items starts with: each line's units
 * received back on returns that were not cancelled or rejected, capped at
 * what was ordered. Empty once any money went back, since an earlier refund
 * may already cover some of those units.
 */
export function receivedReturnLineQuantities(
  items: readonly OrderItem[],
  returns: readonly Pick<OrderReturnDto, "status" | "lines">[],
  alreadyRefunded: number,
): Record<string, number> {
  if (alreadyRefunded > 0) return {};
  const received = new Map<string, number>();
  for (const orderReturn of returns) {
    if (orderReturn.status === "cancelled" || orderReturn.status === "rejected") continue;
    for (const line of orderReturn.lines) {
      if (line.receivedQuantity > 0) received.set(line.orderItemId, (received.get(line.orderItemId) ?? 0) + line.receivedQuantity);
    }
  }
  return Object.fromEntries(refundableLines(items)
    .filter((item) => (received.get(item.id) ?? 0) > 0)
    .map((item) => [item.id, Math.min(item.quantity, received.get(item.id) ?? 0)]));
}
