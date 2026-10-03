import { lazy, Suspense, type ComponentProps } from "react";
import type { OrderHoldCard as OrderHoldCardType } from "./OrderHoldCard";

// The hold card (its release dialog and mutation) loads only on an order an
// app put on hold: most orders never carry one, so the page does not pay for it.
const OrderHoldCard = lazy(() => import("./OrderHoldCard").then((module) => ({ default: module.OrderHoldCard })));

/** An app's hold for staff review, rendered only when card-rules says one is open. */
export function LazyOrderHoldCard(props: ComponentProps<typeof OrderHoldCardType>) {
  return (
    <Suspense fallback={null}>
      <OrderHoldCard {...props} />
    </Suspense>
  );
}
