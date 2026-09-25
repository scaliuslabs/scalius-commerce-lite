import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Package } from "lucide-react";
import { toast } from "sonner";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { canTransitionTo } from "@scalius/shared/order-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useCurrency } from "~/hooks/use-currency";
import { useHydrated } from "~/hooks/use-hydrated";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useMarkPickupReady, useVoidFulfillment } from "~/lib/api-mutations/orders";
import { orderReturnsQueryOptions } from "~/lib/api-query-options/orders";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import {
  formatSavedMajorAmount,
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { useCancelRequestGuard } from "./CancelRequestGuard";
import { LineProperties } from "./LineProperties";
import { ManualFulfillmentDialog, type ManualFulfillmentKind } from "./ManualFulfillmentDialog";
import { returnedQuantities } from "./OrderItemsCard";
import { BookCourier } from "./ShipmentCard";
import { formatCurrencyAmount, formatOrderTimestamp } from "./formatters";
import {
  canHandOver,
  fulfilledGroups,
  isManualGroup,
  isReadyForPickup,
  unfulfilledGroups,
  type FulfilledGroup,
  type GroupLine,
  type UnfulfilledGroup,
} from "./fulfilment-groups";
import type { OrderActionRequest } from "./primary-action";
import type { Order, OrderFulfillment } from "./types";

/** Orders whose story is over: their lines keep their cards, without status badges or actions. */
const CLOSED_ORDER_STATUSES = new Set(["cancelled", "returned", "refunded", "incomplete"]);

type Money = { major: (amount: number) => string; minor: (amount: number) => string };

function useOrderMoney(order: Order): Money & { saved: ReturnType<typeof resolveSavedOrderMoneySummary> } {
  const { fmt } = useCurrency();
  const saved = resolveSavedOrderMoneySummary(order);
  const decimals = saved?.decimalPlaces ?? 2;
  return {
    saved,
    major: (amount) => (saved ? formatSavedMajorAmount(amount, saved) : formatCurrencyAmount(amount, order.currencyCode ?? "BDT")),
    minor: (amount) => (saved ? formatSavedMinorAmount(amount, saved) : fmt(amount / 10 ** decimals)),
  };
}

/**
 * "Mark as ready for pickup", from the Pickup card or the page's next step.
 * One key per attempt: a retry after a failure replays it; a success ends it.
 */
export function usePickupReadyAction(orderId: string) {
  const mutation = useMarkPickupReady();
  const key = useRef<string | null>(null);
  const run = () => {
    key.current ??= crypto.randomUUID();
    mutation.mutate({ orderId, requestKey: key.current }, { onSuccess: () => { key.current = null; } });
  };
  return { run, isPending: mutation.isPending };
}

/**
 * Shopify's order page: one card per group of lines, by what still has to
 * happen and how it reaches the buyer (Unfulfilled · Shipping, Pickup,
 * Service, automatic), then one card per hand-over already recorded, each
 * with its own actions.
 */
export function OrderFulfilmentCards({ order, request, onRecordPayment }: {
  order: Order;
  request?: OrderActionRequest | null;
  /** Opens the payment card's "record the cash" flow (the order's next step). */
  onRecordPayment?: () => void;
}) {
  const t = useMessages(orderDetailMessages);
  const hydrated = useHydrated();
  const money = useOrderMoney(order);
  // The Returns card reads the same query; this only reuses it.
  const returnsQuery = useQuery({ ...orderReturnsQueryOptions(order.id), enabled: hydrated, staleTime: ORDER_DETAIL_PREFETCH_STALE_MS });
  const returned = useMemo(() => returnedQuantities(returnsQuery.data?.returns ?? []), [returnsQuery.data]);
  const open = unfulfilledGroups(order);
  const done = fulfilledGroups(order);
  // Handed over, money still due: say so and offer the next step (a toast with an action stays 10 s).
  const awaitingPayment = () => toast.info(t("handover.awaitingPayment"), {
    duration: 10_000,
    ...(onRecordPayment ? { action: { label: t("handover.recordPayment"), onClick: onRecordPayment } } : {}),
  });
  return (
    <>
      {open.map((group) => (
        <UnfulfilledCard key={`open-${group.type}`} order={order} group={group} money={money} request={request} onAwaitingPayment={awaitingPayment} />
      ))}
      {done.map((group, index) => (
        <FulfilledCard
          key={group.fulfillment?.id ?? `done-${group.type}`}
          order={order}
          group={group}
          number={index + 1}
          money={money}
          returned={returned}
        />
      ))}
    </>
  );
}

function LineRow({ line, money, order, returned }: {
  line: GroupLine;
  money: Money;
  order: Order;
  returned?: number;
}) {
  const t = useMessages(orderDetailMessages);
  const { item, quantity } = line;
  const saved = resolveSavedOrderMoneySummary(order);
  const lineMoney = resolveSavedOrderLineMoney(item, saved);
  const unit = lineMoney ? money.minor(lineMoney.unitPriceMinor) : money.major(item.price);
  const total = lineMoney ? money.minor(lineMoney.unitPriceMinor * quantity) : money.major(item.price * quantity);
  return (
    <li className="flex items-start gap-3 py-3 text-body first:pt-0 last:pb-0">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
        {item.productImage ? (
          <img src={mediaImageUrl(item.productImage, 128)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
        ) : (
          <Package className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1 break-words">
        <Link to="/admin/products/$productId/edit" params={{ productId: item.productId }} className="font-medium hover:underline">
          {item.productName || t("items.unnamed")}
        </Link>
        {item.variantLabel ? <p className="text-muted-foreground">{item.variantLabel}</p> : null}
        <LineProperties item={item} money={money.major} />
        <p className="text-muted-foreground tabular-nums">{unit} × {formatNumber(quantity)}</p>
        {returned ? <p className="text-muted-foreground">{t("items.returned", { count: returned })}</p> : null}
      </div>
      <p className="shrink-0 font-medium tabular-nums">{total}</p>
    </li>
  );
}

function GroupHeader({ badge, badgeVariant, title, description, actions }: {
  badge: string | null;
  badgeVariant: BadgeVariant;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <CardHeader>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {badge ? <Badge variant={badgeVariant}>{badge}</Badge> : null}
          <CardTitle>{title}</CardTitle>
        </div>
        {actions}
      </div>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
  );
}

const GROUP_TITLES: Record<FulfillmentType, "group.ship" | "group.pickup" | "group.service" | "group.digital" | "group.gift_card"> = {
  ship: "group.ship",
  pickup: "group.pickup",
  service: "group.service",
  digital: "group.digital",
  gift_card: "group.gift_card",
};

/** What still has to reach the buyer, by how it gets there, with the one next action. */
function UnfulfilledCard({ order, group, money, request, onAwaitingPayment }: {
  order: Order;
  group: UnfulfilledGroup;
  money: Money & { saved: ReturnType<typeof resolveSavedOrderMoneySummary> };
  request?: OrderActionRequest | null;
  onAwaitingPayment: () => void;
}) {
  const t = useMessages(orderDetailMessages);
  const permissions = useOrderActionPermissions();
  const cardRef = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<ManualFulfillmentKind | null>(null);
  const cancelRequest = useCancelRequestGuard(order);
  const pickupReady = usePickupReadyAction(order.id);
  const status = order.status.toLowerCase();
  const closed = CLOSED_ORDER_STATUSES.has(status);
  const canAct = permissions.canManageOrderShipments && canHandOver(order) && isManualGroup(group.type);
  const ready = group.type === "pickup" && isReadyForPickup(order);
  const providers = order.deliveryProviders ?? [];
  const couriersKnown = (order.operationalReads?.deliveryProviders.status ?? "ready") !== "unavailable";
  const canBook = canAct && group.type === "ship" && status === "confirmed"
    && order.fulfillmentStatus !== "complete" && canTransitionTo("order", order.status, "shipped");

  useEffect(() => {
    if (!request) return;
    const mine = (group.type === "ship" && (request.action === "bookCourier" || request.action === "sendOwnCourier"))
      || (group.type === "pickup" && request.action === "markPickedUp")
      || (group.type === "service" && request.action === "markServiceDone");
    if (!mine) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!canAct) return;
    if (request.action === "sendOwnCourier") setDialog("ship");
    if (request.action === "markPickedUp") setDialog("pickup");
    if (request.action === "markServiceDone") setDialog("service");
    // Only a new request should act.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  const delivery = resolveDeliveryMethodPresentation({ ...order, shippingFeeWaived: false }, money.saved);
  const description = group.type === "ship"
    ? (order.shippingMethodName ? delivery.label : null)
    : group.type === "pickup"
      ? <PickupDetails order={order} />
      : t(group.type === "service" ? "group.serviceHelp" : "group.automaticHelp");
  const badge = closed ? null : ready ? t("badge.readyForPickup") : t(group.type === "service" ? "badge.notDone" : "badge.unfulfilled");

  let footer: ReactNode = null;
  if (canAct && group.type === "ship") {
    footer = (
      <div className="w-full space-y-3">
        {canBook && couriersKnown && providers.length > 0 ? (
          <BookCourier order={order} guard={(run) => cancelRequest.guard("send", run)} focusRequest={request?.action === "bookCourier" ? request.id : undefined} />
        ) : null}
        <div className="flex justify-end">
          <Button type="button" variant={providers.length > 0 && canBook ? "outline" : "default"} onClick={() => cancelRequest.guard("send", () => setDialog("ship"))}>
            {t("fulfill.submit")}
          </Button>
        </div>
      </div>
    );
  } else if (canAct && group.type === "pickup") {
    footer = (
      <div className="flex w-full flex-wrap justify-end gap-2">
        {!ready && status === "confirmed" ? (
          <>
            <Button type="button" variant="outline" onClick={() => setDialog("pickup")}>{t("pickup.submit")}</Button>
            <Button type="button" loading={pickupReady.isPending} onClick={pickupReady.run}>{t("primary.markReadyForPickup")}</Button>
          </>
        ) : (
          <Button type="button" onClick={() => setDialog("pickup")}>{t("pickup.submit")}</Button>
        )}
      </div>
    );
  } else if (canAct && group.type === "service") {
    footer = (
      <div className="flex w-full justify-end">
        <Button type="button" onClick={() => setDialog("service")}>{t("service.submit")}</Button>
      </div>
    );
  }

  return (
    <Card ref={cardRef} id={`order-unfulfilled-${group.type}`} className="scroll-mt-4" data-testid={`unfulfilled-${group.type}`}>
      <GroupHeader
        badge={badge}
        badgeVariant={ready ? "info" : "attention"}
        title={t("group.title", { name: t(GROUP_TITLES[group.type]), count: group.units })}
        description={description}
      />
      <CardContent>
        <ul className="divide-y">
          {group.lines.map((line) => <LineRow key={line.item.id} line={line} money={money} order={order} />)}
        </ul>
      </CardContent>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
      {isManualGroup(group.type) ? (
        <ManualFulfillmentDialog
          order={order}
          kind={group.type}
          open={dialog === group.type}
          onOpenChange={(open) => setDialog(open ? group.type as ManualFulfillmentKind : null)}
          onAwaitingPayment={onAwaitingPayment}
        />
      ) : null}
      {cancelRequest.dialog}
    </Card>
  );
}

function PickupDetails({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const readyAt = order.pickupReadyAt ?? order.pickup?.readyAt ?? null;
  return (
    <span className="block space-y-1">
      {order.pickup?.address ? <span className="block whitespace-pre-wrap">{t("pickup.at", { address: order.pickup.address })}</span> : null}
      {order.pickup?.hours ? <span className="block whitespace-pre-wrap">{order.pickup.hours}</span> : null}
      {readyAt ? <span className="block">{t("pickup.readySince", { date: formatOrderTimestamp(readyAt) ?? "" })}</span> : null}
    </span>
  );
}

const DONE_BADGES: Record<FulfillmentType, "badge.sent" | "badge.pickedUp" | "badge.done" | "badge.delivered"> = {
  ship: "badge.sent",
  pickup: "badge.pickedUp",
  service: "badge.done",
  digital: "badge.delivered",
  gift_card: "badge.delivered",
};

/** One recorded hand-over: what went, when, how, and its actions menu. */
function FulfilledCard({ order, group, number, money, returned }: {
  order: Order;
  group: FulfilledGroup;
  number: number;
  money: Money;
  returned: Map<string, number>;
}) {
  const t = useMessages(orderDetailMessages);
  const [voiding, setVoiding] = useState(false);
  const fulfillment = group.fulfillment;
  const canManage = useOrderActionPermissions().canManageOrderShipments;
  const canVoid = canManage && fulfillment?.canVoid === true && !order.archivedAt;
  // The server says whether and why not; an archived order is restored first.
  const blockedReason = canManage && fulfillment && typeof fulfillment.canVoid === "boolean" && !canVoid
    ? t(order.archivedAt ? "void.blocked.archived" : `void.blocked.${fulfillment.voidBlockedReason ?? "voided"}`)
    : null;
  const when = fulfillment ? formatOrderTimestamp(fulfillment.createdAt) : null;
  const description = [
    when ? t(fulfillment?.actorType === "system" ? "fulfilled.automaticAt" : "fulfilled.at", { date: when }) : null,
    fulfillment?.cashCollected != null ? t("fulfilled.cash", { amount: money.major(fulfillment.cashCollected) }) : null,
  ].filter(Boolean).join(" · ");
  const voidLabel = t(group.type === "ship" ? "shipments.cameBack" : "void.menu");
  const actions = canVoid || blockedReason ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("fulfilled.actions")} title={t("fulfilled.actions")}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {blockedReason ? (
          // A disabled item takes no pointer events: the tooltip hangs on its wrapper.
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block" data-testid="void-blocked">
                <DropdownMenuItem disabled>
                  {voidLabel}
                  <span className="sr-only">{blockedReason}</span>
                </DropdownMenuItem>
              </span>
            </TooltipTrigger>
            <TooltipContent>{blockedReason}</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuItem onSelect={() => setVoiding(true)}>{voidLabel}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <Card data-testid={`fulfilled-${group.type}`}>
      <GroupHeader
        badge={t(DONE_BADGES[group.type])}
        badgeVariant="secondary"
        title={t("group.fulfilledTitle", { name: t(GROUP_TITLES[group.type]), number })}
        description={description || undefined}
        actions={actions}
      />
      <CardContent className="space-y-3">
        <ul className="divide-y">
          {group.lines.map((line) => (
            <LineRow key={line.item.id} line={line} money={money} order={order} returned={returned.get(line.item.id)} />
          ))}
        </ul>
        {fulfillment?.tracking ? <TrackingLine tracking={fulfillment.tracking} /> : null}
      </CardContent>
      {fulfillment ? (
        <VoidFulfillmentDialog order={order} fulfillment={fulfillment} units={group.units} open={voiding} onOpenChange={setVoiding} />
      ) : null}
    </Card>
  );
}

function TrackingLine({ tracking }: { tracking: NonNullable<OrderFulfillment["tracking"]> }) {
  const t = useMessages(orderDetailMessages);
  return (
    <p className="border-t pt-3 text-body text-muted-foreground">
      {tracking.courierName || t("fulfill.defaultCourier")}
      {tracking.trackingId ? <>{" · "}{t("shipments.trackingId")}: <code>{tracking.trackingId}</code></> : null}
      {tracking.trackingUrl ? (
        <>
          {" · "}
          <a href={tracking.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">{t("shipments.track")}</a>
        </>
      ) : null}
    </p>
  );
}

/** Void a hand-over: its units go back on the unfulfilled list. One key per opened dialog. */
export function VoidFulfillmentDialog({ order, fulfillment, units, open, onOpenChange }: {
  order: Pick<Order, "id">;
  fulfillment: Pick<OrderFulfillment, "id" | "kind">;
  units: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const mutation = useVoidFulfillment();
  const key = useRef("");
  useEffect(() => {
    if (!open) return;
    key.current = crypto.randomUUID();
    mutation.reset();
    // Every opening is a new attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const ship = fulfillment.kind === "ship";
  return (
    <AlertDialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(ship ? "shipments.cameBackTitle" : "void.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {ship
              ? units === 1 ? t("shipments.cameBackOne") : t("shipments.cameBackMany", { count: units })
              : units === 1 ? t("void.bodyOne") : t("void.body", { count: units })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.isError ? <p role="alert" className="text-body text-destructive">{orderErrorMessage(mutation.error)}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>{r("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={mutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              mutation.mutate(
                { orderId: order.id, fulfillmentId: fulfillment.id, requestKey: key.current },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            {t(ship ? "shipments.cameBack" : "void.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
