import {
  GENERIC_ADMIN_ORDER_STATUS_TARGETS,
  GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS,
  isGenericAdminOrderStatusTransitionAllowed,
} from "@scalius/shared/order-admin-actions";
import { ORDER_MACHINE, type OrderStatusValue } from "@scalius/shared/order-state";
import type { MachineRefusal } from "@scalius/shared/machine";
import { ConflictError } from "@scalius/core/errors";

// The generic status editor's moves are shared with the dashboard's menu
// (@scalius/shared/order-admin-actions), so the two never disagree.

/**
 * The statuses the generic editor sets from some state: exactly what
 * `dashboard.orders.update_status` offers, so its schema never offers a value
 * it refuses in every state (policy.test.ts derives it from the move table).
 */
export { GENERIC_ADMIN_ORDER_STATUS_TARGETS };

export { isGenericAdminOrderStatusTransitionAllowed };

/**
 * Refuses a status the generic editor does not set from `current` (409),
 * with where the order is and the statuses it may set from there. (Its
 * route refuses a status recorded by another operation before this, naming it.)
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
  // The dashboard only offers allowed moves, so a refusal means the order
  // changed since it was loaded: the page reloads it.
  throw new ConflictError(
    `This order is now ${statusWords(current)}, so it can't be marked ${statusWords(next)}. Reload to see the latest.`,
    refusal,
  );
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}
