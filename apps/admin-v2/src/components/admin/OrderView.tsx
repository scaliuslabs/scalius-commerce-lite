import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ChevronDown, ChevronLeft, ChevronRight, MessageCircle, Phone } from "lucide-react";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Alert } from "~/components/ui/alert";
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
import { editLockMessageKey, orderEditLockMessages } from "~/i18n/order-edit-locks";
import { orderChannelText, orderMessages } from "~/i18n/orders";
import { formatOrderTimestamp } from "./orderview/formatters";
import { useMarkOrderDelivered, useRestoreOrder, useUpdateOrderStatus } from "~/lib/api-mutations/orders";
import { orderSkipReason } from "./order-list/order-bulk-actions";
import { useArchiveOrdersWithUndo } from "./order-list/use-order-list-mutations";
import { clearOrderNotice, useOrderNotice } from "~/lib/order-notice";
import { useOrderListReturnHref } from "~/lib/order-list-return";
import { useToastsAboveBar } from "~/lib/toast";
import { ErrorBoundary } from "./ErrorBoundary";
import { OrderCustomerCard } from "./orderview/OrderCustomerCard";
import { OrderFulfilmentCards, usePickupReadyAction } from "./orderview/OrderFulfilmentCards";
import { LazyOrderHoldCard } from "./orderview/LazyOrderHoldCard";
import { OrderNotesCard } from "./orderview/OrderNotesCard";
import { OrderStatusCard } from "./orderview/OrderStatusCard";
import { OrderConversationCard } from "./orderview/OrderConversationCard";
import { LazyOrderNotificationsCard, LazyOrderReturnsCard, LazyOrderTimelineCard } from "./orderview/LazyOrderCards";
import { PaymentCard } from "./orderview/PaymentCard";
import { ShipmentCard } from "./orderview/ShipmentCard";
import { hasDeliveryCard, hasHoldCard } from "./orderview/card-rules";
import { OrderHeaderBadges } from "./orderview/OrderHeaderBadges";
import { useCancelRequestGuard } from "./orderview/CancelRequestGuard";
import { resolveOrderPrimaryAction, unitsLeftToSend, type OrderActionRequest } from "./orderview/primary-action";
import { customerContactLinks } from "./orderview/contact-links";
import { useOrderNeighbours } from "./orderview/order-neighbours";
import { ariaKeys } from "./layout/shortcuts";
import { usePagerShortcuts } from "./shared/use-pager-shortcuts";
import type { Order } from "./orderview/types";
import { LazyCustomFieldsCard } from "./custom-fields/LazyCustomFieldsCard";
import { appActionKey, useAppActionRunner } from "./apps/ui/AppActions";
import { AppResourceCards } from "./apps/ui/AppResourceCards";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";
import { Page } from "~/components/admin/resource/Page";

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
  const f = useMessages(orderEditLockMessages);
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
  const neighbours = useOrderNeighbours(order.id);
  const navigate = useNavigate();
  const openOrder = (id: string | null | undefined) => (id ? () => void navigate({ to: "/admin/orders/$orderId", params: { orderId: id } }) : null);
  usePagerShortcuts({ previous: openOrder(neighbours?.previous), next: openOrder(neighbours?.next) });
  // An order placed without a phone (a digital or service order) has no call or WhatsApp link.
  const contact = order.customerPhone ? customerContactLinks(order.customerPhone) : null;
  const name = formatOrderNumber(order.orderNumber, order.id);
  const archived = Boolean(order.archivedAt);
  const canEditCustomData = usePermissions().hasPermission(PERMISSIONS.ORDERS_EDIT);
  // Finished orders (delivered, cancelled, returned, refunded) leave the working list (R3-ORD-11).
  const canArchive = actions.canBulkDeleteOrders && !archived && orderSkipReason(order, "archive") === null;
  const appActions = useAppActionRunner("order", false);
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

  // The header's one meta line (P1): when and where the order was placed.
  const placedAt = formatOrderTimestamp(order.createdAt);
  const orderMeta = [
    placedAt ? t("status.placedAt", { date: placedAt }) : null,
    order.channel ? orderChannelText(o, order.channel, order.channelSource) : null,
  ].filter(Boolean).join(" · ") || undefined;

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
        <Page width="detail" className="space-y-4 pb-24 lg:pb-0">
          <PageHeader
            backTo={backTo}
            title={o("order", { number: name })}
            status={<OrderHeaderBadges order={order} />}
            meta={orderMeta}
            actions={
              <>
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
                {actions.canPrintInvoices || canArchive || appActions.entries.length > 0 ? (
                  // Polaris: secondary actions past the first fold into a named "More actions" menu (C4).
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" loading={appActions.pending !== null}>
                        {t("moreActions")}
                        <ChevronDown className="size-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {actions.canPrintInvoices ? (
                        <DropdownMenuItem asChild>
                          <Link to="/invoice/$orderId" params={{ orderId: order.id }} target="_blank" rel="noopener noreferrer">
                            {t("printInvoice")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      {canArchive ? (
                        <DropdownMenuItem
                          disabled={archiveMutation.isPending}
                          onSelect={() => archiveMutation.mutate({ orders: [{ id: order.id, version: order.version }], skipped: 0 })}
                        >
                          <span className="flex h-lh items-center"><Archive className="size-4" /></span>
                          {t("archive")}
                        </DropdownMenuItem>
                      ) : null}
                      {/* Apps' actions for this order (apps.use). */}
                      {appActions.entries.map((entry) => (
                        <DropdownMenuItem
                          key={appActionKey(entry)}
                          variant={entry.action.destructive ? "destructive" : undefined}
                          onSelect={() => appActions.start(entry, [order.id])}
                        >
                          {entry.action.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {appActions.dialogs}
                {primaryButton ?<span className="hidden lg:inline-flex">{primaryButton}</span> : null}
                <div className="hidden lg:flex">
                  <NeighbourLink orderId={neighbours?.previous ?? null} label={t("nav.previous")} keys={ariaKeys("previousItem")}><ChevronLeft className="size-4" /></NeighbourLink>
                  <NeighbourLink orderId={neighbours?.next ?? null} label={t("nav.next")} keys={ariaKeys("nextItem")}><ChevronRight className="size-4" /></NeighbourLink>
                </div>
              </>
            }
          />

          {/* An app's hold for staff review, only while one is open (card-rules.ts). */}
          {hasHoldCard(order) ? <LazyOrderHoldCard order={order} /> : null}

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
              {/* Courier parcels once something was sent (card-rules.ts). */}
              {hasDeliveryCard(order) ? <div className="order-4 lg:order-none"><ShipmentCard order={order} /></div> : null}
              {/* Shopify's Payment card: the order's money (subtotal, delivery, discounts, tax, total), then what was paid. */}
              <div className="order-5 lg:order-none"><PaymentCard order={order} request={request} /></div>
              {/* As on Shopify, what to hand over and the money come first; the conversation sits above the timeline.
                  Cards that may not apply hide their wrapper too, so the gaps stay even. */}
              <div className="order-8 empty:hidden lg:order-none"><LazyOrderReturnsCard order={order} onRefund={() => setRequest({ action: "refund", id: Date.now() })} /></div>
              <div className="order-9 empty:hidden lg:order-none"><OrderConversationCard order={order} request={request} /></div>
              <div className="order-10 lg:order-none"><LazyOrderNotificationsCard order={order} /></div>
              <div className="order-11 lg:order-none"><LazyOrderTimelineCard order={order} /></div>
            </div>
            <div className="contents lg:block lg:space-y-4">
              <div className="order-1 lg:order-none"><OrderStatusCard order={order} /></div>
              <div className="order-6 lg:order-none"><OrderCustomerCard order={order} /></div>
              <div className="order-7 empty:hidden lg:order-none"><LazyCustomFieldsCard ownerType="order" ownerId={order.id} canEdit={canEditCustomData} /></div>
              {order.notes ? <div className="order-7 lg:order-none"><OrderNotesCard notes={order.notes} /></div> : null}
              <AppResourceCards target="order" id={order.id} className="order-7 space-y-4 lg:order-none" />
            </div>
          </div>
        </Page>

        <PhoneActionBar>
          {contact ? (
            <Button variant="outline" size={primary ? "icon" : "lg"} className={primary ? "shrink-0" : "flex-1"} asChild>
              <a href={contact.call} aria-label={t("contact.callName", { name: order.customerName })}>
                <Phone className="size-4" />
                {primary ? null : t("contact.call")}
              </a>
            </Button>
          ) : null}
          {contact?.whatsapp ? (
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
 * While the bar shows, toasts sit above it.
 */
function PhoneActionBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useToastsAboveBar(ref);
  return (
    <div ref={ref} className="fixed inset-x-0 bottom-0 z-40 flex gap-2 border-t bg-background p-3 lg:hidden">
      {children}
    </div>
  );
}

function NeighbourLink({ orderId, label, keys, children }: { orderId: string | null; label: string; keys: string; children: ReactNode }) {
  if (!orderId) {
    return <Button variant="ghost" size="icon" disabled aria-label={label}>{children}</Button>;
  }
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link to="/admin/orders/$orderId" params={{ orderId }} aria-label={label} aria-keyshortcuts={keys} title={`${label} (${keys})`}>{children}</Link>
    </Button>
  );
}
