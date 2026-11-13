import { OrderStatus } from "@scalius/database/schema";
import { isGenericAdminOrderStatusTransitionAllowed } from "@scalius/shared/order-admin-actions";
import { ConflictError, ValidationError } from "@scalius/core/errors";

// The generic status editor's moves are shared with the dashboard's menu
// (@scalius/shared/order-admin-actions), so the two never disagree.
/** Where each fulfilment or money status really comes from, in the merchant's words. */
const FULFILMENT_STATUS_PATHS: Readonly<Record<string, string>> = {
  [OrderStatus.SHIPPED]: "Use Mark as sent or Book courier: they record what left and move the stock.",
  [OrderStatus.DELIVERED]: "Record the cash as collected, or use Mark delivered once everything is sent.",
  [OrderStatus.RETURNED]: "Use Mark returned, or a return on the order page.",
  [OrderStatus.REFUNDED]: "Use Refund on the order page for this.",
};

export { isGenericAdminOrderStatusTransitionAllowed };

export function assertGenericAdminOrderStatusTransition(current: string, next: string): void {
  if (isGenericAdminOrderStatusTransitionAllowed(current, next)) return;
  const fulfilmentPath = FULFILMENT_STATUS_PATHS[next];
  if (fulfilmentPath) throw new ValidationError(fulfilmentPath);
  // The dashboard only offers allowed moves, so a refusal means the order
  // changed since it was loaded: answer 409 so the page reloads it.
  throw new ConflictError(
    `This order is now ${statusWords(current)}, so it can't be marked ${statusWords(next)}. Reload to see the latest.`,
  );
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}
