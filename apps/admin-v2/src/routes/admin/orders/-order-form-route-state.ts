import { editLockMessageKey, type OrderEditLockMessageKey } from "~/i18n/order-edit-locks";
import { translate } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";

interface EditState {
  allowed: boolean;
  reason: string | null;
}

/**
 * Edit order has one mode: change the items before shipment (the server's
 * amendment quote). Otherwise the page explains why, and whether the customer
 * and address can still be edited from the order page.
 */
export function orderEditState(readiness: { items: EditState; details: EditState }):
  | { mode: "amend" }
  | { mode: "locked"; message: OrderEditLockMessageKey; canEditDetails: boolean } {
  if (readiness.items.allowed) return { mode: "amend" };
  return {
    mode: "locked",
    message: editLockMessageKey(readiness.items.reason),
    canEditDetails: readiness.details.allowed,
  };
}

/**
 * The edit form's delivery method. The form data carries none, so the order's
 * saved method is preselected (and named even when no longer offered), never
 * "Custom charge" for an order placed with a named method.
 */
export function savedDeliveryMethod(order: {
  shippingMethodId: string | null;
  shippingMethodName: string | null;
  /** Pickup orders keep no address; the edit form must not ask for one. */
  shippingMethodKind?: "delivery" | "pickup" | null;
}) {
  const shippingMethodKind = order.shippingMethodKind ?? null;
  if (!order.shippingMethodId) return { shippingMethodId: null, shippingMethodKind, savedShippingMethod: null };
  return {
    shippingMethodId: order.shippingMethodId,
    shippingMethodKind,
    savedShippingMethod: {
      id: order.shippingMethodId,
      // A method removed since: named in words, never by its id.
      name: order.shippingMethodName ?? translate(orderFormMessages, "savedDeliveryMethod"),
      kind: shippingMethodKind,
    },
  };
}
