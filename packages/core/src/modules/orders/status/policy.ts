import {
  GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS,
  isGenericAdminOrderStatusTransitionAllowed,
} from "@scalius/shared/order-admin-actions";
import { ORDER_MACHINE, ORDER_STATUSES, type OrderStatusValue } from "@scalius/shared/order-state";
import type { MachineRefusal } from "@scalius/shared/machine";
import { ConflictError } from "@scalius/core/errors";

// The generic status editor's moves are shared with the dashboard's menu
// (@scalius/shared/order-admin-actions), so the two never disagree.

/**
 * The statuses the generic editor sets from some state: exactly what
 * `dashboard.orders.update_status` offers, so its schema never offers a value
 * it refuses in every state.
 */
export const GENERIC_ADMIN_ORDER_STATUS_TARGETS = ORDER_STATUSES.filter((target) =>
  Object.values(GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS).some((targets) => targets.includes(target))) as [OrderStatusValue, ...OrderStatusValue[]];

/** Where each fulfilment or money status really comes from: the operations that record it with its stock and money. */
const FULFILMENT_STATUS_OPERATIONS: Readonly<Partial<Record<OrderStatusValue, string>>> = {
  shipped: "dashboard.orders.fulfillment_create (your own rider) or dashboard.orders.create_shipment (a courier)",
  delivered: "dashboard.orders.cod_update with action collected, or dashboard.orders.mark_delivered once everything is sent",
  returned: "dashboard.orders.cod_update with action returned, or dashboard.orders.return_create",
  refunded: "dashboard.orders.refund",
};

export { isGenericAdminOrderStatusTransitionAllowed };

/**
 * Refuses a status the generic editor does not set from `current` (409),
 * with where the order is and the statuses it may set from there; a
 * fulfilment or money status names the operation that records it.
 */
export function assertGenericAdminOrderStatusTransition(current: string, next: string): void {
  if (isGenericAdminOrderStatusTransitionAllowed(current, next)) return;
  const refusal: MachineRefusal = {
    reason: "state_conflict",
    machine: ORDER_MACHINE.name,
    current,
    move: next,
    allowed: [...(GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS[current as OrderStatusValue] ?? [])],
  };
  const elsewhere = FULFILMENT_STATUS_OPERATIONS[next as OrderStatusValue];
  // The dashboard only offers allowed moves, so any other refusal means the
  // order changed since it was loaded: the page reloads it.
  throw new ConflictError(
    elsewhere
      ? `The order is not marked ${statusWords(next)} here: use ${elsewhere}.`
      : `This order is now ${statusWords(current)}, so it can't be marked ${statusWords(next)}. Reload to see the latest.`,
    refusal,
  );
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}
