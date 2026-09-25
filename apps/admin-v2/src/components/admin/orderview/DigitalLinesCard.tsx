import { lazy, Suspense } from "react";
import { digitalDeliveryOf } from "./digital-lines";
import type { Order } from "./types";

// Loaded only for orders with digital lines to show.
const DigitalLinesBody = lazy(() => import("./DigitalLinesBody").then((module) => ({ default: module.DigitalLinesBody })));

/**
 * "Digital · Delivered automatically": files with their download counts, keys
 * by last 4, resend; and any digital line a paid order still owes.
 */
export function DigitalLinesCard({ order }: { order: Order }) {
  const delivery = digitalDeliveryOf(order);
  if (delivery.lines.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <DigitalLinesBody orderId={order.id} delivery={delivery} />
    </Suspense>
  );
}
