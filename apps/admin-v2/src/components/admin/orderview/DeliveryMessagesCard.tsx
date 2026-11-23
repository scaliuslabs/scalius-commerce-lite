import { lazy, Suspense } from "react";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { messageLinesOf } from "./delivery-messages";
import type { Order } from "./types";

// Loaded only for staff who may write the messages.
const DeliveryMessagesBody = lazy(() => import("./DeliveryMessagesBody").then((module) => ({ default: module.DeliveryMessagesBody })));

/**
 * "Delivery messages": what staff write for the buyer of a line (a game
 * account's sign-in, a step to follow) on any line. Shown to staff who manage
 * digital access; on an order of parcels only it opens closed (`messagesExpectedOn`).
 */
export function DeliveryMessagesCard({ order }: { order: Order }) {
  const { canManageDigitalAccess } = useOrderActionPermissions();
  const lines = messageLinesOf(order);
  if (!canManageDigitalAccess || lines.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <DeliveryMessagesBody orderId={order.id} lines={lines} />
    </Suspense>
  );
}
