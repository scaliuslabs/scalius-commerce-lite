import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Archive, ChevronLeft, ChevronRight, MessageCircle, MoreHorizontal, Phone } from "lucide-react";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Alert } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderFormMessages } from "~/i18n/order-form";
import {
  fulfillmentStatusLabel,
  orderMessages,
  orderStatusLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { useMarkOrderDelivered, useRestoreOrder, useUpdateOrderStatus } from "~/lib/api-mutations/orders";
import { orderSkipReason } from "./order-list/order-bulk-actions";
import { useArchiveOrdersWithUndo } from "./order-list/use-order-list-mutations";
import { clearOrderNotice, useOrderNotice } from "~/lib/order-notice";
import { useOrderListReturnHref } from "~/lib/order-list-return";
import { editLockMessageKey } from "~/routes/admin/orders/-order-form-route-state";
import { ErrorBoundary } from "./ErrorBoundary";
import { OrderCustomerCard } from "./orderview/OrderCustomerCard";
import { OrderFulfilmentCards, usePickupReadyAction } from "./orderview/OrderFulfilmentCards";
import { OrderSummaryCard } from "./orderview/OrderItemsCard";
import { OrderNotesCard } from "./orderview/OrderNotesCard";
import { OrderNotificationsCard } from "./orderview/OrderNotificationsCard";
import { OrderReturnsCard } from "./orderview/OrderReturnsCard";
import { OrderStatusCard } from "./orderview/OrderStatusCard";
import { OrderConversationCard } from "./orderview/OrderConversationCard";
import { OrderTimelineCard } from "./orderview/OrderTimelineCard";
import { PaymentCard } from "./orderview/PaymentCard";
import { hasDeliveryCard, ShipmentCard } from "./orderview/ShipmentCard";
import { useCancelRequestGuard } from "./orderview/CancelRequestGuard";
import { resolveOrderPrimaryAction, unitsLeftToSend, type OrderActionRequest } from "./orderview/primary-action";
import { orderBadgeVisibility, statusBadgeVariant } from "./orderview/status-badges";
import { customerContactLinks } from "./orderview/contact-links";
import { useOrderNeighbours } from "./orderview/order-neighbours";
import type { Order } from "./orderview/types";

/** Order statuses worth repeating in the header next to payment and delivery. */
const HEADER_ORDER_STATUSES = new Set(["cancelled", "returned", "refunded", "incomplete"]);
/** Item locks that the order's state already explains; the others get a reason. */
const SELF_EXPLAINED_LOCKS = new Set(["shipped", "closed", "archived"]);

/**
 * Shopify-style order page. Desktop: main column (items, delivery, payment,
 * returns, messages, timeline) and a side column (status, customer, notes).
 * Phones: one column in working order, with the next step in a bottom bar.
 */
export function OrderView({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const f = useMessages(orderFormMessages);
  const actions = useOrderActionPermissions();
  const statusMutation = useUpdateOrderStatus();
  const restoreMutation = useRestoreOrder();
  const deliveredMutation = useMarkOrderDelivered();
  const pickupReady = usePickupReadyAction(order.id);
  const archiveMutation = useArchiveOrdersWithUndo({ canUndo: actions.canRestoreOrders });
  const notice = useOrderNotice(order.id);
  const [request, setRequest] = useState<OrderActionRequest | null>(null);
  const cancelRequest = useCancelRequestGuard(order);
  const backTo = useOrderListReturnHref();
  const primary = resolveOrderPrimaryAction(order, actions);
  const leftToSend = primary === "sendOwnCourier" ? unitsLeftToSend(order) : 0;
  const primaryLabel = leftToSend > 0 ? t("primary.sendOwnCourierLeft", { count: leftToSend }) : primary ? t(`primary.${primary}`) : "";
  const status = order.status.toLowerCase();
  const badges = orderBadgeVisibility(order);
  const neighbours = useOrderNeighbours(order.id);
  const contact = customerContactLinks(order.customerPhone);
  const name = formatOrderNumber(order.orderNumber, order.id);
  const archived = Boolean(order.archivedAt);
  // Finished orders (delivered, cancelled, returned, refunded) leave the working list (R3-ORD-11).
  const canArchive = actions.canBulkDeleteOrders && !archived && orderSkipReason(order, "archive") === null;
  const itemsLock = order.editReadiness.items;
  const editBlockedReason = order.activeRefundOperation?.active
    ? t("locked.refund")
    : order.shipmentRecovery?.activeLock
      ? t("locked.shipment")
      : !itemsLock.allowed && itemsLock.reason && !SELF_EXPLAINED_LOCKS.has(itemsLock.reason)
        ? f(editLockMessageKey(itemsLock.reason))
        : null;
  const canEdit = actions.canEditOrders && (itemsLock.allowed || editBlockedReason !== null);

  // The page banner belongs to this order only.
  useEffect(() => () => clearOrderNotice(order.id), [order.id]);

  const runPrimary = () => {
    if (!primary) return;
    clearOrderNotice(order.id);
    if (primary === "confirm") {
      cancelRequest.guard("confirm", () => statusMutation.mutate({ orderId: order.id, status: "confirmed" }));
    } else if (primary === "markDelivered") {
      deliveredMutation.mutate({ orderId: order.id });
    } else if (primary === "markReadyForPickup") {
      pickupReady.run();
    } else if (primary === "bookCourier" || primary === "sendOwnCourier") {
      cancelRequest.guard("send", () => setRequest({ action: primary, id: Date.now() }));
    } else {
      setRequest({ action: primary, id: Date.now() });
    }
  };

  const primaryPending = (primary === "confirm" && statusMutation.isPending)
    || (primary === "markDelivered" && deliveredMutation.isPending)
    || (primary === "markReadyForPickup" && pickupReady.isPending);
  const primaryButton = primary ? (
    <Button onClick={runPrimary} loading={primaryPending}>
      {primaryLabel}
    </Button>
  ) : null;

  return (
    <ErrorBoundary
      fallback={
        <div className="space-y-2 p-4 text-center text-body text-muted-foreground">
          <p>{t("loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>{t("reload")}</Button>
        </div>
      }
    >
      <TooltipProvider>
        <div className="space-y-4 pb-24 lg:pb-0">
          <PageHeader
            backTo={backTo}
            title={o("order", { number: name })}
            badge={
              <div className="flex flex-wrap gap-1">
                {archived ? <Badge variant="secondary">{o("archived")}</Badge> : null}
                {order.conversation?.unread ? (
                  // The Messages card sits lower on the page: an unread reply is still seen first.
                  <a href="#order-requests" className="inline-flex rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Badge variant="info">{t("messages.unread")}</Badge>
                  </a>
                ) : null}
                {HEADER_ORDER_STATUSES.has(status) ? (
                  <Badge variant={statusBadgeVariant(status, "order")}>{orderStatusLabel(o, status)}</Badge>
                ) : null}
                {badges.payment && order.paymentStatus ? (
                  <Badge variant={statusBadgeVariant(order.paymentStatus, "payment")}>{paymentStatusLabel(o, order.paymentStatus)}</Badge>
                ) : null}
                {badges.fulfillment && order.fulfillmentStatus ? (
                  // Phones see fulfilment in the Delivery card; keep the title readable.
                  <span className="hidden sm:inline-flex">
                    <Badge variant={statusBadgeVariant(order.fulfillmentStatus, "fulfillment")}>{fulfillmentStatusLabel(o, order.fulfillmentStatus)}</Badge>
                  </span>
                ) : null}
              </div>
            }
            actions={
              <>
                {actions.canPrintInvoices ? (
                  <Button variant="outline" asChild>
                    <Link to="/invoice/$orderId" params={{ orderId: order.id }} target="_blank" rel="noopener noreferrer">
                      {t("printInvoice")}
                    </Link>
                  </Button>
                ) : null}
                {canEdit ? (
                  editBlockedReason ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={0}>
                          <Button variant="outline" disabled>{t("edit")}</Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{editBlockedReason}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Button variant="outline" asChild>
                      <Link to="/admin/orders/$orderId/edit" params={{ orderId: order.id }}>{t("edit")}</Link>
                    </Button>
                  )
                ) : null}
                {archived && actions.canRestoreOrders ? (
                  <Button
                    variant="outline"
                    loading={restoreMutation.isPending}
                    onClick={() => restoreMutation.mutate({ id: order.id, expectedVersion: order.version })}
                  >
                    {t("unarchive")}
                  </Button>
                ) : null}
                {canArchive ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" aria-label={t("moreActions")} title={t("moreActions")}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={archiveMutation.isPending}
                        onSelect={() => archiveMutation.mutate({ orders: [{ id: order.id, version: order.version }], skipped: 0 })}
                      >
                        <span className="flex h-lh items-center"><Archive className="size-4" /></span>
                        {t("archive")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {primaryButton ?<span className="hidden lg:inline-flex">{primaryButton}</span> : null}
                <div className="hidden lg:flex">
                  <NeighbourLink orderId={neighbours?.previous ?? null} label={t("nav.previous")}><ChevronLeft className="size-4" /></NeighbourLink>
                  <NeighbourLink orderId={neighbours?.next ?? null} label={t("nav.next")}><ChevronRight className="size-4" /></NeighbourLink>
                </div>
              </>
            }
          />

          {notice ? (
            <Alert variant="warning">
              <div className="flex items-center justify-between gap-2">
                <p>{notice}</p>
                <Button variant="ghost" size="sm" onClick={() => clearOrderNotice(order.id)}>{t("dismiss")}</Button>
              </div>
            </Alert>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
            <div className="contents lg:col-span-2 lg:block lg:space-y-4">
              {/* Messages: the order's requests, its conversation and the reply box (hidden without access). */}
              <div id="order-fulfilment" className="order-3 scroll-mt-4 space-y-4 lg:order-none"><OrderFulfilmentCards order={order} request={request} onRecordPayment={() => setRequest({ action: "collectCod", id: Date.now() })} /></div>
              <div className="order-4 lg:order-none"><OrderSummaryCard order={order} /></div>
              {hasDeliveryCard(order) ? <div className="order-4 lg:order-none"><ShipmentCard order={order} /></div> : null}
              <div className="order-5 lg:order-none"><PaymentCard order={order} request={request} /></div>
              {/* As on Shopify, what to hand over and the money come first; the conversation sits above the timeline. */}
              <div className="order-8 lg:order-none"><OrderReturnsCard order={order} onRefund={() => setRequest({ action: "refund", id: Date.now() })} /></div>
              <div className="order-9 lg:order-none"><OrderConversationCard order={order} request={request} /></div>
              <div className="order-10 lg:order-none"><OrderNotificationsCard order={order} /></div>
              <div className="order-11 lg:order-none"><OrderTimelineCard order={order} /></div>
            </div>
            <div className="contents lg:block lg:space-y-4">
              <div className="order-1 lg:order-none"><OrderStatusCard order={order} /></div>
              <div className="order-6 lg:order-none"><OrderCustomerCard order={order} /></div>
              {order.notes ? <div className="order-7 lg:order-none"><OrderNotesCard notes={order.notes} /></div> : null}
            </div>
          </div>
        </div>

        <PhoneActionBar>
          <Button variant="outline" size={primary ? "icon" : "lg"} className={primary ? "shrink-0" : "flex-1"} asChild>
            <a href={contact.call} aria-label={t("contact.callName", { name: order.customerName })}>
              <Phone className="size-4" />
              {primary ? null : t("contact.call")}
            </a>
          </Button>
          {contact.whatsapp ? (
            <Button variant="outline" size={primary ? "icon" : "lg"} className={primary ? "shrink-0" : "flex-1"} asChild>
              <a href={contact.whatsapp} target="_blank" rel="noopener noreferrer" aria-label={t("contact.whatsappName", { name: order.customerName })}>
                <MessageCircle className="size-4" />
                {primary ? null : t("contact.whatsapp")}
              </a>
            </Button>
          ) : null}
          {primary ? (
            <Button className="flex-1" size="lg" onClick={runPrimary} loading={primaryPending}>
              {primaryLabel}
            </Button>
          ) : null}
        </PhoneActionBar>
        {cancelRequest.dialog}
      </TooltipProvider>
    </ErrorBoundary>
  );
}

/**
 * Phones: Call and WhatsApp stay in thumb reach, next to the one next step.
 * While the bar shows, toasts sit above it (`--toast-lift`, read by the Toaster).
 */
function PhoneActionBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = ref.current;
    const root = document.documentElement;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => root.style.setProperty("--toast-lift", `${bar.offsetHeight}px`));
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--toast-lift");
    };
  }, []);
  return (
    <div ref={ref} className="fixed inset-x-0 bottom-0 z-40 flex gap-2 border-t bg-background p-3 lg:hidden">
      {children}
    </div>
  );
}

function NeighbourLink({ orderId, label, children }: { orderId: string | null; label: string; children: ReactNode }) {
  if (!orderId) {
    return <Button variant="ghost" size="icon" disabled aria-label={label}>{children}</Button>;
  }
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link to="/admin/orders/$orderId" params={{ orderId }} aria-label={label}>{children}</Link>
    </Button>
  );
}
