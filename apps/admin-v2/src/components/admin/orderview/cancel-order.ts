import type { UpdateOrderStatusInput } from "~/lib/api-mutations/orders";
import { fulfilledUnits } from "./fulfilment-groups";
import type { Order } from "./types";

// What cancelling an order does to its units, apart from the status card, so
// the cancel confirmation loads without it.

type CancelReason = NonNullable<UpdateOrderStatusInput["reason"]>;
export const CANCEL_REASONS: CancelReason[] = ["customer_changed_mind", "unreachable", "fake_order", "out_of_stock", "other"];

/** Units that go back on sale when the order is cancelled: not handed over, stock-tracked items only. */
export function restockedUnits(order: Pick<Order, "items">): number {
  return order.items
    .filter((item) => item.inventoryTracked !== false)
    .reduce((sum, item) => sum + Math.max(0, item.quantity - fulfilledUnits(item)), 0);
}

/** Units handed over (with a courier, picked up, performed): the order can't be cancelled then. */
export function unitsWithCourier(order: Pick<Order, "items">): number {
  return order.items.reduce((sum, item) => sum + fulfilledUnits(item), 0);
}

/** Why Cancelled isn't offered, in the merchant's words; null when it can be. */
export function shippedCancelReason(
  order: Pick<Order, "items">,
  t: (key: "cancel.shippedOne" | "cancel.shippedMany", vars: { count: number }) => string,
): string | null {
  const count = unitsWithCourier(order);
  return count === 0 ? null : t(count === 1 ? "cancel.shippedOne" : "cancel.shippedMany", { count });
}
