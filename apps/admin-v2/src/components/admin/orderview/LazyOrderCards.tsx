import { lazy, Suspense, type ComponentProps } from "react";
import type { OrderConversationCard as OrderConversationCardType } from "./OrderConversationCard";
import type { OrderNotificationsCard as OrderNotificationsCardType } from "./OrderNotificationsCard";

// The page's last two cards (the customer conversation and the message log) sit
// below everything an order needs first, so their code and words load after it.
const OrderConversationCard = lazy(() => import("./OrderConversationCard").then((module) => ({ default: module.OrderConversationCard })));
const OrderNotificationsCard = lazy(() => import("./OrderNotificationsCard").then((module) => ({ default: module.OrderNotificationsCard })));

export function LazyOrderConversationCard(props: ComponentProps<typeof OrderConversationCardType>) {
  return (
    <Suspense fallback={null}>
      <OrderConversationCard {...props} />
    </Suspense>
  );
}

export function LazyOrderNotificationsCard(props: ComponentProps<typeof OrderNotificationsCardType>) {
  return (
    <Suspense fallback={null}>
      <OrderNotificationsCard {...props} />
    </Suspense>
  );
}
