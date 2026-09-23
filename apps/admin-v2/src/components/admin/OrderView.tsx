import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MessageCircle, Phone } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { TooltipProvider } from "~/components/ui/tooltip";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import {
  fulfillmentStatusLabel,
  orderMessages,
  orderStatusLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { useUpdateOrderStatus } from "~/lib/api-mutations/orders";
import { ErrorBoundary } from "./ErrorBoundary";
import { OrderCustomerCard } from "./orderview/OrderCustomerCard";
import { OrderItemsCard } from "./orderview/OrderItemsCard";
import { OrderNotesCard } from "./orderview/OrderNotesCard";
import { OrderNotificationsCard } from "./orderview/OrderNotificationsCard";
import { OrderReturnsCard } from "./orderview/OrderReturnsCard";
import { OrderStatusCard } from "./orderview/OrderStatusCard";
import { OrderSupportRequestsCard } from "./orderview/OrderSupportRequestsCard";
import { PaymentCard } from "./orderview/PaymentCard";
import { ShipmentCard } from "./orderview/ShipmentCard";
import { resolveOrderPrimaryAction } from "./orderview/primary-action";
import { orderBadgeVisibility, statusBadgeVariant } from "./orderview/status-badges";
import { customerContactLinks } from "./orderview/contact-links";
import { useOrderNeighbours } from "./orderview/order-neighbours";
import type { Order } from "./orderview/types";

/** Order statuses worth repeating in the header next to payment and delivery. */
const HEADER_ORDER_STATUSES = new Set(["cancelled", "returned", "refunded", "partially_refunded", "incomplete"]);

/**
 * Shopify-style order page. Desktop: main column (items, delivery, payment,
 * returns, messages) and a side column (status, customer, notes). Phones: one
 * column in working order, with the next step in a bottom bar.
 */
export function OrderView({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const actions = useOrderActionPermissions();
  const statusMutation = useUpdateOrderStatus();
  const [request, setRequest] = useState<{ action: "bookCourier" | "collectCod"; id: number } | null>(null);
  const primary = resolveOrderPrimaryAction(order, actions);
  const status = order.status.toLowerCase();
  const badges = orderBadgeVisibility(order);
  const neighbours = useOrderNeighbours(order.id);
  const contact = customerContactLinks(order.customerPhone);
  // Orders that can never be edited (e.g. storefront orders with saved tax) show no Edit.
  const canEditContents = order.fullEditReadiness.allowed || order.amendmentReadiness?.allowed === true;
  const editBlockedReason = order.activeRefundOperation?.active
    ? t("locked.refund")
    : order.shipmentRecovery?.activeLock
      ? t("locked.shipment")
      : null;

  const runPrimary = () => {
    if (primary === "confirm") statusMutation.mutate({ orderId: order.id, status: "confirmed" });
    else if (primary) setRequest({ action: primary, id: Date.now() });
  };

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
            backTo="/admin/orders"
            title={o("order", { id: order.id })}
            badge={
              <div className="flex flex-wrap gap-1">
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
                <Button variant="outline" asChild>
                  <Link to="/invoice/$orderId" params={{ orderId: order.id }} target="_blank" rel="noopener noreferrer">
                    {t("printInvoice")}
                  </Link>
                </Button>
                {actions.canEditOrders && canEditContents ? (
                  editBlockedReason ? (
                    <Button variant="outline" disabled title={editBlockedReason}>{t("edit")}</Button>
                  ) : (
                    <Button variant="outline" asChild>
                      <Link to="/admin/orders/$orderId/edit" params={{ orderId: order.id }}>{t("edit")}</Link>
                    </Button>
                  )
                ) : null}
                {neighbours ? (
                  <div className="flex">
                    <NeighbourLink orderId={neighbours.previous} label={t("nav.previous")}><ChevronLeft className="size-4" /></NeighbourLink>
                    <NeighbourLink orderId={neighbours.next} label={t("nav.next")}><ChevronRight className="size-4" /></NeighbourLink>
                  </div>
                ) : null}
              </>
            }
          />

          <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
            <div className="contents lg:col-span-2 lg:block lg:space-y-4">
              {(order.supportRequests?.length ?? 0) > 0 ? (
                <div className="order-2 lg:order-none"><OrderSupportRequestsCard order={order} /></div>
              ) : null}
              <div className="order-3 lg:order-none"><OrderItemsCard order={order} /></div>
              <div className="order-5 lg:order-none">
                <ShipmentCard order={order} bookRequest={request?.action === "bookCourier" ? request.id : undefined} />
              </div>
              <div className="order-4 lg:order-none">
                <PaymentCard order={order} collectRequest={request?.action === "collectCod" ? request.id : undefined} />
              </div>
              <div className="order-8 lg:order-none"><OrderReturnsCard order={order} /></div>
              <div className="order-9 lg:order-none"><OrderNotificationsCard order={order} /></div>
            </div>
            <div className="contents lg:block lg:space-y-4">
              <div className="order-1 lg:order-none"><OrderStatusCard order={order} /></div>
              <div className="order-6 lg:order-none"><OrderCustomerCard order={order} /></div>
              {order.notes ? <div className="order-7 lg:order-none"><OrderNotesCard notes={order.notes} /></div> : null}
            </div>
          </div>
        </div>

        {/* Phones: Call and WhatsApp stay in thumb reach, next to the one next step. */}
        <div className="fixed inset-x-0 bottom-0 z-40 flex gap-2 border-t bg-background p-3 lg:hidden">
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
            <Button className="flex-1" size="lg" onClick={runPrimary} disabled={statusMutation.isPending}>
              {t(`primary.${primary}`)}
            </Button>
          ) : null}
        </div>
      </TooltipProvider>
    </ErrorBoundary>
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
