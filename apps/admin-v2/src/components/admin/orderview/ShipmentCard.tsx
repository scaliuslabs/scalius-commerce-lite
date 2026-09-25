import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { ShipmentMetadataDisplay } from "~/components/ui/ShipmentMetadataDisplay";
import ShipmentStatusIndicator from "~/components/admin/ShipmentStatusIndicator";
import {
  getProviderReadinessLabel,
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "~/components/admin/delivery-providers/ProviderIcon";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useHydrated } from "~/hooks/use-hydrated";
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailLabel, orderDetailMessages, shipmentRecoveryCopy } from "~/i18n/order-detail";
import { fulfillmentStatusLabel, orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import {
  orderErrorMessage,
  useCreateOrderShipment,
  useLookupUnknownShipment,
  useMarkOrderDelivered,
  useReconcileShipment,
  useResolveUnknownShipment,
} from "~/lib/api-mutations/orders";
import { orderCodQueryOptions } from "~/lib/api-query-options/orders";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import { formatSavedMajorAmount, resolveSavedOrderMoneySummary } from "~/lib/order-tax-presentation";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import { getOrderItemName } from "./order-returns/shared";
import { OperationalReadNotice } from "./OperationalReadNotice";
import { formatCurrencyAmount, formatOrderDate } from "./formatters";
import { statusBadgeVariant } from "./status-badges";
import type { Order, OrderFulfillment, OrderItem, OrderShipment } from "./types";
import { canMarkDelivered, isPartSent } from "./primary-action";

type Outcome = "confirmed_existing" | "confirmed_not_created" | "confirmed_cancelled";
type EvidenceSource = "courier_portal" | "courier_support";
const OUTCOMES: Outcome[] = ["confirmed_existing", "confirmed_not_created", "confirmed_cancelled"];
const EVIDENCE_SOURCES: EvidenceSource[] = ["courier_portal", "courier_support"];

function courierName(providerType: string | null | undefined): string {
  const name = providerType?.trim() || "courier";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function trackingUrlFor(shipment: OrderShipment): string | null {
  if (!shipment.trackingId) return null;
  if (shipment.trackingUrl) return shipment.trackingUrl;
  const id = encodeURIComponent(shipment.trackingId);
  if (shipment.providerType === "pathao") return `https://merchant.pathao.com/tracking?consignment_id=${id}`;
  if (shipment.providerType === "steadfast") return `https://steadfast.com.bd/t/${id}`;
  return null;
}

/**
 * What one parcel holds, e.g. "2 × Kurta": the lines of the ledger
 * fulfilment recorded with it. A parcel no fulfilment names lists nothing.
 */
export function shipmentLines(
  shipmentId: string,
  fulfillments: readonly OrderFulfillment[],
  items: readonly OrderItem[],
): Array<{ id: string; name: string; quantity: number }> {
  const fulfilment = fulfillments.find((candidate) => candidate.tracking?.shipmentId === shipmentId);
  if (!fulfilment) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return fulfilment.lines.map((line) => ({
    id: line.orderItemId,
    name: getOrderItemName(byId.get(line.orderItemId)),
    quantity: line.quantity,
  }));
}

function toIsoTimestamp(value: OrderShipment["lastChecked"]): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return undefined;
}

/**
 * The courier may or may not have booked this order. The merchant must check
 * the courier account and confirm before anything can be booked again.
 */
function CourierCheckDialog({
  order,
  shipmentId,
  open,
  onOpenChange,
}: {
  order: Order;
  shipmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const mutation = useResolveUnknownShipment();
  const [outcome, setOutcome] = useState<Outcome>("confirmed_existing");
  const [evidenceSource, setEvidenceSource] = useState<EvidenceSource>("courier_portal");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [externalId, setExternalId] = useState("");
  const [trackingId, setTrackingId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const operationKey = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOutcome("confirmed_existing");
    setEvidenceSource("courier_portal");
    setEvidenceNote("");
    setExternalId("");
    setTrackingId("");
    setConfirmed(false);
    operationKey.current = null;
    mutation.reset();
    // Every opening starts clean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any edit after ticking the box needs a fresh confirmation and key.
  const edited = () => {
    setConfirmed(false);
    operationKey.current = null;
  };
  const close = () => {
    operationKey.current = null;
    onOpenChange(false);
  };
  const ready = confirmed
    && evidenceNote.trim().length >= 8
    && (outcome !== "confirmed_existing" || externalId.trim().length > 0);
  const submit = () => {
    if (!ready) return;
    operationKey.current ??= crypto.randomUUID();
    mutation.mutate({
      orderId: order.id,
      shipmentId,
      expectedOrderVersion: order.version,
      operationKey: operationKey.current,
      outcome,
      evidenceSource,
      evidenceNote: evidenceNote.trim(),
      confirmationAccepted: true,
      ...(outcome === "confirmed_existing"
        ? { externalId: externalId.trim(), ...(trackingId.trim() ? { trackingId: trackingId.trim() } : {}) }
        : {}),
    }, { onSuccess: close });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("courier.checkTitle")}</DialogTitle>
          <DialogDescription>{t("courier.checkHelp", { courier: courierName(order.shipmentRecovery?.providerType) })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="courier-outcome">{t("courier.outcome")}</Label>
            <NativeSelect id="courier-outcome" disabled={mutation.isPending} value={outcome} onValueChange={(value) => { setOutcome(value as Outcome); edited(); }}>
              {OUTCOMES.map((value) => <option key={value} value={value}>{t(`courier.outcome.${value}`)}</option>)}
            </NativeSelect>
          </div>
          {outcome === "confirmed_existing" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="courier-consignment">{t("courier.consignmentId")}</Label>
                <Input id="courier-consignment" value={externalId} maxLength={180} disabled={mutation.isPending} onChange={(e) => { setExternalId(e.target.value); edited(); }} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="courier-tracking">{t("shipments.trackingId")}</Label>
                <Input id="courier-tracking" value={trackingId} maxLength={180} disabled={mutation.isPending} onChange={(e) => { setTrackingId(e.target.value); edited(); }} />
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="courier-source">{t("courier.source")}</Label>
            <NativeSelect id="courier-source" disabled={mutation.isPending} value={evidenceSource} onValueChange={(value) => { setEvidenceSource(value as EvidenceSource); edited(); }}>
              {EVIDENCE_SOURCES.map((value) => <option key={value} value={value}>{t(`courier.source.${value}`)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="courier-evidence">{t("courier.details")}</Label>
            <Textarea
              id="courier-evidence"
              value={evidenceNote}
              maxLength={500}
              disabled={mutation.isPending}
              placeholder={t("courier.detailsPlaceholder")}
              onChange={(e) => { setEvidenceNote(e.target.value); edited(); }}
            />
          </div>
          {mutation.isError ? <p role="alert" className="text-destructive">{orderErrorMessage(mutation.error)}</p> : null}
          <div className="flex items-start gap-3">
            <span className="flex h-5 items-center">
              <Checkbox id="courier-confirmed" checked={confirmed} disabled={mutation.isPending} onCheckedChange={(value) => setConfirmed(value === true)} />
            </span>
            <Label htmlFor="courier-confirmed">{t("courier.confirm")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} loading={mutation.isPending} disabled={!ready}>
            {r("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShipmentRecoveryNotice({ order, canManage, onCourierCheck }: {
  order: Order;
  canManage: boolean;
  onCourierCheck: () => void;
}) {
  const t = useMessages(orderDetailMessages);
  const recovery = order.shipmentRecovery;
  const repairMutation = useReconcileShipment();
  const lookupMutation = useLookupUnknownShipment();
  const lookupKey = useRef<string | null>(null);
  const copy = recovery ? shipmentRecoveryCopy(t, recovery.reason) : null;
  if (!recovery || recovery.state === "none" || !copy) return null;

  const blocking = recovery.state === "needs_attention" && recovery.activeLock && Boolean(recovery.shipmentId);
  const canRepair = canManage && blocking && recovery.canRepair;
  const needsCourierCheck = canManage && blocking && recovery.status === "reconcile_required"
    && !recovery.canRepair && recovery.unknownOutcome === true;
  const shipmentId = recovery.shipmentId ?? "";

  const lookup = () => {
    lookupKey.current ??= crypto.randomUUID();
    lookupMutation.mutate(
      { orderId: order.id, shipmentId, expectedOrderVersion: order.version, operationKey: lookupKey.current },
      { onSuccess: () => { lookupKey.current = null; } },
    );
  };

  return (
    <div role="status" className="space-y-2">
      <p className={cn("font-medium", recovery.severity === "danger" && "text-destructive")}>{copy.label}</p>
      <p className="text-muted-foreground">{copy.help}</p>
      {needsCourierCheck || canRepair ? (
        <div className="flex flex-wrap gap-2">
          {needsCourierCheck && recovery.providerType === "steadfast" ? (
            <Button type="button" size="sm" variant="outline" loading={lookupMutation.isPending} onClick={lookup}>
              {t("courier.checkSteadfast")}
            </Button>
          ) : null}
          {needsCourierCheck ? (
            <Button type="button" size="sm" variant="outline" onClick={onCourierCheck}>
              {t("courier.checkTitle")}
            </Button>
          ) : null}
          {canRepair ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={repairMutation.isPending}
              onClick={() => repairMutation.mutate({ orderId: order.id, shipmentId })}
            >
              {t("shipments.repair")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ShipmentRow({
  shipment,
  fulfillments,
  items,
  canManage,
  refreshBlockedReason,
  statusLabel,
  failureNote,
  money,
  onUpdated,
}: {
  shipment: OrderShipment;
  fulfillments: readonly OrderFulfillment[];
  items: readonly OrderItem[];
  canManage: boolean;
  refreshBlockedReason?: string;
  /** Overrides the courier status, e.g. "Delivery failed · attempt 1 · No cash". */
  statusLabel?: string;
  /** What the rider wrote about a failed delivery. */
  failureNote?: string | null;
  money: (amount: number) => string;
  onUpdated: () => void;
}) {
  const t = useMessages(orderDetailMessages);
  const [expanded, setExpanded] = useState(false);
  const refreshable = Boolean(shipment.providerId);
  const trackingUrl = trackingUrlFor(shipment);
  const provider = shipment.providerType === "manual"
    ? shipment.courierName || t("fulfill.defaultCourier")
    : shipment.providerName ?? shipment.courierName ?? shipment.providerType;

  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ShipmentStatusIndicator
          shipment={{ id: shipment.id, status: shipment.status, orderId: shipment.orderId, lastChecked: toIsoTimestamp(shipment.lastChecked) }}
          label={statusLabel}
          onStatusUpdated={onUpdated}
          canRefresh={canManage && refreshable && !refreshBlockedReason}
          showLastChecked={refreshable}
          refreshDisabledReason={canManage && refreshable ? refreshBlockedReason : undefined}
        />
        <span className="text-muted-foreground">{formatOrderDate(shipment.createdAt)}</span>
      </div>
      {failureNote ? <p className="whitespace-pre-wrap text-muted-foreground">{failureNote}</p> : null}
      <p>
        {provider}
        {shipment.providerType !== "manual" && shipment.courierName && shipment.courierName !== shipment.providerName ? ` · ${shipment.courierName}` : ""}
      </p>
      <ul className="text-muted-foreground">
        {shipmentLines(shipment.id, fulfillments, items).map((line) => (
          <li key={line.id} className="break-words tabular-nums">{formatNumber(line.quantity)} × {line.name}</li>
        ))}
      </ul>
      {shipment.trackingId ? (
        <p className="text-muted-foreground">
          {t("shipments.trackingId")}: <code>{shipment.trackingId}</code>
          {trackingUrl ? (
            <>
              {" · "}
              <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
                {t("shipments.track")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {shipment.shipmentAmount != null ? (
        <p className="text-muted-foreground tabular-nums">
          {t("shipments.cost", { amount: money(shipment.shipmentAmount) })}
        </p>
      ) : null}
      {shipment.note ? <p className="whitespace-pre-wrap text-muted-foreground">{shipment.note}</p> : null}
      {shipment.metadata && shipment.providerType !== "manual" ? (
        <>
          <Button type="button" variant="link" size="sm" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            {expanded ? t("shipments.hideDetails") : t("shipments.showDetails")}
          </Button>
          {expanded ? <ShipmentMetadataDisplay metadata={shipment.metadata} /> : null}
        </>
      ) : null}
    </li>
  );
}

/** Book one of the connected couriers for every ship line (the Unfulfilled · Ship card). */
export function BookCourier({ order, focusRequest, guard }: {
  order: Order;
  focusRequest?: number;
  guard: (run: () => void) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const queryClient = useQueryClient();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [providerId, setProviderId] = useState("");
  const mutation = useCreateOrderShipment();
  const providers = order.deliveryProviders ?? [];
  const selected = providers.find((provider) => provider.id === providerId);
  const readiness = selected ? resolveProviderReadiness(selected) : null;
  const noneReady = providers.length > 0 && providers.every((provider) => !resolveProviderReadiness(provider).canCreateShipment);
  const blocker = readiness && !readiness.canCreateShipment
    ? getProviderReadinessMessage(readiness)
    : noneReady ? getProviderReadinessMessage(resolveProviderReadiness(providers[0]!)) : "";
  const read = order.operationalReads?.deliveryProviders ?? { status: "ready" as const, refreshing: false };
  const locked = Boolean(order.activeRefundOperation?.active) || order.shipmentRecovery?.activeLock === true;
  // Pathao books by City → Zone (→ Area); without them the courier rejects the booking.
  const missingArea = selected?.type === "pathao" && (!order.city || !order.zone);
  const notice = (
    <OperationalReadNotice
      read={read}
      label={t("shipments.couriersFailed")}
      onRetry={() => void queryClient.refetchQueries({ queryKey: queryKeys.settings.deliveryProviders(), type: "active" })}
    />
  );

  useEffect(() => {
    if (focusRequest) triggerRef.current?.focus();
  }, [focusRequest]);

  if (read.status === "loading" || read.status === "unavailable") return notice;
  if (providers.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">{t("shipments.noCouriers")}</p>
        <Button asChild variant="link" size="sm">
          <Link to="/admin/settings/shipping">{t("shipments.connectCourier")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {notice}
      <Label htmlFor="book-courier">{t("shipments.courier")}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SearchableSelect
          id="book-courier"
          triggerRef={triggerRef}
          value={providerId}
          onValueChange={(value) => { setProviderId(value); mutation.reset(); }}
          disabled={read.status !== "ready" || mutation.isPending || locked}
          placeholder={t("shipments.chooseCourier")}
          triggerClassName="w-full"
          options={providers.map((provider) => {
            const providerReadiness = resolveProviderReadiness(provider);
            return {
              value: provider.id,
              label: provider.name,
              description: getProviderReadinessLabel(providerReadiness),
              disabled: !providerReadiness.canCreateShipment,
            };
          })}
        />
        <Button
          className="shrink-0"
          loading={mutation.isPending}
          onClick={() => guard(() => mutation.mutate({ orderId: order.id, providerId, options: {} }))}
          disabled={!providerId || readiness?.canCreateShipment === false || read.status !== "ready" || locked || missingArea}
        >
          {t("shipments.book")}
        </Button>
      </div>
      {blocker ? <p className="text-muted-foreground">{blocker}</p> : null}
      {missingArea ? <p className="text-muted-foreground">{t("shipments.needsArea")}</p> : null}
      {mutation.isError ? <p role="alert" className="text-destructive">{orderErrorMessage(mutation.error)}</p> : null}
    </div>
  );
}

const CLOSED_ORDER_STATUSES = new Set(["cancelled", "returned", "refunded", "incomplete"]);
const SETTLED_SHIPMENT_STATUSES = new Set(["delivered", "returned", "cancelled", "failed"]);

/** Whether the order has courier parcels to follow: it ships, or parcels exist from before. */
export function hasDeliveryCard(order: Pick<Order, "requiresShipping" | "shipments" | "shipmentRecovery">): boolean {
  return order.requiresShipping !== false
    || (order.shipments ?? []).length > 0
    || (order.shipmentRecovery?.state ?? "none") !== "none";
}

/**
 * The courier side of an order that ships: each parcel's live status and
 * tracking, a courier booking that needs checking, and Mark delivered. What
 * is sent and what is left live on the fulfilment cards above it.
 */
export function ShipmentCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const queryClient = useQueryClient();
  const hydrated = useHydrated();
  const [courierCheckOpen, setCourierCheckOpen] = useState(false);
  const permissions = useOrderActionPermissions();
  const canManage = permissions.canManageOrderShipments;
  const deliveredMutation = useMarkOrderDelivered();
  const read = order.operationalReads?.shipments ?? { status: "ready" as const, refreshing: false };
  const shipments = order.shipments ?? [];
  const status = order.status.toLowerCase();
  const saved = resolveSavedOrderMoneySummary(order);
  const money = (amount: number) => (saved ? formatSavedMajorAmount(amount, saved) : formatCurrencyAmount(amount, order.currencyCode ?? "BDT"));
  const refreshBlockedReason = order.activeRefundOperation?.active
    ? t("locked.refund")
    : order.shipmentRecovery?.activeLock ? t("locked.shipment") : undefined;
  const partSent = isPartSent(order);
  const canDeliver = permissions.canChangeOrderStatus && canMarkDelivered(order);
  // A recorded failed delivery replaces "In transit" on the shipment still out, once:
  // "Delivery failed · attempt 1 · No cash" (R3-ORD-05).
  const outForDelivery = status === "shipped" || partSent;
  const codQuery = useQuery({
    ...orderCodQueryOptions(order.id),
    enabled: hydrated && order.paymentMethod === "cod" && outForDelivery,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });
  const cod = hydrated && outForDelivery ? codQuery.data?.tracking ?? null : null;
  const failure = cod?.codStatus === "failed" ? cod : null;
  const openShipmentId = shipments.find((shipment) => !SETTLED_SHIPMENT_STATUSES.has(shipment.status.toLowerCase()))?.id;
  const openLabel = status === "returned"
    ? t("cod.status.returned")
    : failure
      ? t("shipments.failedAttempt", {
        count: failure.deliveryAttempts,
        reason: orderDetailLabel(t, "cod.reason.", failure.failureReason ?? "other"),
      })
      : undefined;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(order.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders.shipments(order.id) });
  };

  return (
    <Card id="order-shipments" className="scroll-mt-4">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("shipments.title")}</CardTitle>
        {order.fulfillmentStatus && !CLOSED_ORDER_STATUSES.has(status) ? (
          <Badge variant={statusBadgeVariant(order.fulfillmentStatus, "fulfillment")}>{fulfillmentStatusLabel(o, order.fulfillmentStatus)}</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ShipmentRecoveryNotice order={order} canManage={canManage} onCourierCheck={() => setCourierCheckOpen(true)} />
        <OperationalReadNotice
          read={read}
          label={t("shipments.loadFailed")}
          onRetry={() => void queryClient.refetchQueries({ queryKey: queryKeys.orders.shipments(order.id), type: "active" })}
        />
        {read.status === "ready" || read.status === "stale" ? (
          shipments.length > 0 ? (
            <ul className="divide-y">
              {shipments.map((shipment) => (
                <ShipmentRow
                  key={shipment.id}
                  shipment={shipment}
                  fulfillments={order.fulfillments ?? []}
                  items={order.items}
                  canManage={canManage}
                  refreshBlockedReason={refreshBlockedReason}
                  statusLabel={shipment.id === openShipmentId ? openLabel : undefined}
                  failureNote={shipment.id === openShipmentId ? failure?.failureNote : null}
                  money={money}
                  onUpdated={refresh}
                />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{t("shipments.empty")}</p>
          )
        ) : null}
        {canDeliver ? (
          <Button type="button" className="w-full" loading={deliveredMutation.isPending} onClick={() => deliveredMutation.mutate({ orderId: order.id })}>
            {t("primary.markDelivered")}
          </Button>
        ) : null}
      </CardContent>
      <CourierCheckDialog
        order={order}
        shipmentId={order.shipmentRecovery?.shipmentId ?? ""}
        open={courierCheckOpen && Boolean(order.shipmentRecovery?.shipmentId)}
        onOpenChange={setCourierCheckOpen}
      />
    </Card>
  );
}
