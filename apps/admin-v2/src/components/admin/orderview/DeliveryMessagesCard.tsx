import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { DeliveryMessagesBody } from "./DeliveryMessagesBody";
import type { Order } from "./types";

/**
 * "Delivery messages": what staff write for the buyer of a line (a game
 * account's sign-in, a step to follow) on any line. Shown to staff who manage
 * digital access; on an order of parcels only it opens closed (`messagesExpectedOn`).
 * The order page loads this file after it has drawn (`OrderFulfilmentCards`).
 */
export function DeliveryMessagesCard({ order }: { order: Order }) {
  const { canManageDigitalAccess } = useOrderActionPermissions();
  // Every line can carry a message, so the card has lines whenever the order has items.
  if (!canManageDigitalAccess || order.items.length === 0) return null;
  return <DeliveryMessagesBody order={order} />;
}
