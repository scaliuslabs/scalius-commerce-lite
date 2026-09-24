import type { OrderFormMessageKey } from "~/i18n/order-form";

interface EditState {
  allowed: boolean;
  reason: string | null;
}

const LOCK_MESSAGE: Record<string, OrderFormMessageKey> = {
  shipped: "lockShipped",
  closed: "lockClosed",
  paid: "lockPaid",
  online_payment: "lockOnlinePayment",
  discount: "lockDiscount",
  history: "lockHistory",
  inventory: "lockInventory",
  archived: "lockArchived",
  busy: "lockBusy",
  unavailable: "lockUnavailable",
};

/** The plain sentence for a server edit-lock reason code. */
export function editLockMessageKey(reason: string | null): OrderFormMessageKey {
  return (reason && LOCK_MESSAGE[reason]) || "lockUnknown";
}

/**
 * Edit order has one mode: change the items before shipment (the server's
 * amendment quote). Otherwise the page explains why, and whether the customer
 * and address can still be edited from the order page.
 */
export function orderEditState(readiness: { items: EditState; details: EditState }):
  | { mode: "amend" }
  | { mode: "locked"; message: OrderFormMessageKey; canEditDetails: boolean } {
  if (readiness.items.allowed) return { mode: "amend" };
  return {
    mode: "locked",
    message: editLockMessageKey(readiness.items.reason),
    canEditDetails: readiness.details.allowed,
  };
}
