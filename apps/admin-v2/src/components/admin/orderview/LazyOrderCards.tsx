import { lazy, Suspense, type ComponentProps } from "react";
import type { OrderNotificationsCard as OrderNotificationsCardType } from "./OrderNotificationsCard";
import type { OrderReturnsCard as OrderReturnsCardType } from "./OrderReturnsCard";
import type { OrderTimelineCard as OrderTimelineCardType } from "./OrderTimelineCard";

// Cards below everything an order needs first: their code and words load after the page.
const OrderNotificationsCard = lazy(() => import("./OrderNotificationsCard").then((module) => ({ default: module.OrderNotificationsCard })));
const OrderReturnsCard = lazy(() => import("./OrderReturnsCard").then((module) => ({ default: module.OrderReturnsCard })));
const OrderTimelineCard = lazy(() => import("./OrderTimelineCard").then((module) => ({ default: module.OrderTimelineCard })));

export function LazyOrderNotificationsCard(props: ComponentProps<typeof OrderNotificationsCardType>) {
  return (
    <Suspense fallback={null}>
      <OrderNotificationsCard {...props} />
    </Suspense>
  );
}

export function LazyOrderReturnsCard(props: ComponentProps<typeof OrderReturnsCardType>) {
  return (
    <Suspense fallback={null}>
      <OrderReturnsCard {...props} />
    </Suspense>
  );
}

export function LazyOrderTimelineCard(props: ComponentProps<typeof OrderTimelineCardType>) {
  return (
    <Suspense fallback={null}>
      <OrderTimelineCard {...props} />
    </Suspense>
  );
}
