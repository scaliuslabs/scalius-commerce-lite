import { lazy, Suspense, type ComponentProps } from "react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { useHasPermission } from "~/contexts/PermissionContext";
import type { OrderConversationCard as OrderConversationCardType } from "./OrderConversationCard";

// The Messages card (its thread read, reply box and copy) sits below the
// money cards, so its code loads right after the page instead of with it. The
// fetch starts as soon as the page's code runs, beside the order's data.
const loadCard = () => import("./OrderConversationCard");
void loadCard().catch(() => {});
const OrderConversationCard = lazy(() => loadCard().then((module) => ({ default: module.OrderConversationCard })));

/**
 * The card draws nothing without conversations access and without requests
 * (the same facts decide here), so the reserved box exists only when the card
 * will: its place on the page is held from the first paint without a spinner.
 */
export function LazyOrderConversationCard(props: ComponentProps<typeof OrderConversationCardType>) {
  const canRead = useHasPermission(PERMISSIONS.CONVERSATIONS_VIEW);
  if (!canRead && (props.order.supportRequests ?? []).length === 0) return null;
  return (
    <Suspense fallback={<div className="min-h-72" aria-hidden />}>
      <OrderConversationCard {...props} />
    </Suspense>
  );
}
