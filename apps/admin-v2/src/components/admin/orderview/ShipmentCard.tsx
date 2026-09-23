import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ShipmentMetadataDisplay } from "~/components/ui/ShipmentMetadataDisplay";
import ShipmentStatusIndicator from "~/components/admin/ShipmentStatusIndicator";
import {
  getProviderReadinessLabel,
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "~/components/admin/delivery-providers/ProviderIcon";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { fulfillmentStatusLabel, orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import {
  useCreateOrderShipment,
  useLookupUnknownShipment,
  useReconcileShipment,
  useResolveUnknownShipment,
} from "~/lib/api-mutations/orders";
import { queryKeys } from "~/lib/query-keys";
import { canTransitionTo } from "@scalius/shared/order-state";
import { cn } from "@scalius/shared/utils";
import { ManualFulfillmentDialog } from "./ManualFulfillmentDialog";
import { OperationalReadNotice } from "./OperationalReadNotice";
import { formatOrderDate } from "./formatters";
import { statusBadgeVariant } from "./status-badges";
import type { Order, OrderShipment } from "./types";

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
            <Select value={outcome} onValueChange={(value) => { setOutcome(value as Outcome); edited(); }}>
              <SelectTrigger id="courier-outcome" disabled={mutation.isPending}><SelectValue /></SelectTrigger>
              <SelectContent>
                {OUTCOMES.map((value) => <SelectItem key={value} value={value}>{t(`courier.outcome.${value}`)}</SelectItem>)}
              </SelectContent>
            </Select>
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
            <Select value={evidenceSource} onValueChange={(value) => { setEvidenceSource(value as EvidenceSource); edited(); }}>
              <SelectTrigger id="courier-source" disabled={mutation.isPending}><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVIDENCE_SOURCES.map((value) => <SelectItem key={value} value={value}>{t(`courier.source.${value}`)}</SelectItem>)}
              </SelectContent>
            </Select>
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
          <div className="flex items-start gap-3">
            <span className="flex h-5 items-center">
              <Checkbox id="courier-confirmed" checked={confirmed} disabled={mutation.isPending} onCheckedChange={(value) => setConfirmed(value === true)} />
            </span>
            <Label htmlFor="courier-confirmed">{t("courier.confirm")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} disabled={mutation.isPending || !ready}>
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
  if (!recovery || recovery.state === "none") return null;

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
      <p className={cn("font-medium", recovery.severity === "danger" && "text-destructive")}>{recovery.label}</p>
      {recovery.message ? <p className="text-muted-foreground">{recovery.message}</p> : null}
      {needsCourierCheck || canRepair ? (
        <div className="flex flex-wrap gap-2">
          {needsCourierCheck && recovery.providerType === "steadfast" ? (
            <Button type="button" size="sm" variant="outline" disabled={lookupMutation.isPending} onClick={lookup}>
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
              disabled={repairMutation.isPending}
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
  canManage,
  refreshBlockedReason,
  onUpdated,
}: {
  shipment: OrderShipment;
  canManage: boolean;
  refreshBlockedReason?: string;
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
          onStatusUpdated={onUpdated}
          canRefresh={canManage && refreshable && !refreshBlockedReason}
          showLastChecked={refreshable}
          refreshDisabledReason={canManage && refreshable ? refreshBlockedReason : undefined}
        />
        <span className="text-muted-foreground">{formatOrderDate(shipment.createdAt)}</span>
      </div>
      <p>
        {provider}
        {shipment.providerType !== "manual" && shipment.courierName && shipment.courierName !== shipment.providerName ? ` · ${shipment.courierName}` : ""}
      </p>
      {shipment.trackingId ? (
        <p className="text-muted-foreground">
          {t("shipments.trackingId")}: <span className="font-mono">{shipment.trackingId}</span>
          {trackingUrl ? (
            <>
              {" · "}
              <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {t("shipments.track")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {shipment.note ? <p className="text-muted-foreground">{shipment.note}</p> : null}
      {shipment.metadata ? (
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

function BookCourier({ order, focusRequest }: { order: Order; focusRequest?: number }) {
  const t = useMessages(orderDetailMessages);
  const queryClient = useQueryClient();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [providerId, setProviderId] = useState("");
  const mutation = useCreateOrderShipment();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const providers = order.deliveryProviders ?? [];
  const selected = providers.find((provider) => provider.id === providerId);
  const readiness = selected ? resolveProviderReadiness(selected) : null;
  const noneReady = providers.length > 0 && providers.every((provider) => !resolveProviderReadiness(provider).canCreateShipment);
  const blocker = readiness && !readiness.canCreateShipment
    ? getProviderReadinessMessage(readiness)
    : noneReady ? getProviderReadinessMessage(resolveProviderReadiness(providers[0]!)) : "";
  const read = order.operationalReads?.deliveryProviders ?? { status: "ready" as const, refreshing: false };
  const locked = refundLocked || shipmentLocked;
  // Pathao books by City → Zone (→ Area); without them the courier rejects the booking.
  const missingArea = selected?.type === "pathao" && (!order.city || !order.zone);
  const canEditOrder = useOrderActionPermissions().canEditOrders
    && (order.fullEditReadiness.allowed || order.amendmentReadiness?.allowed === true);

  useEffect(() => {
    if (focusRequest) triggerRef.current?.focus();
  }, [focusRequest]);

  const book = () => {
    if (refundLocked) return void toast.error(t("locked.refund"));
    if (shipmentLocked) return void toast.error(t("locked.shipment"));
    if (!providerId) return void toast.error(t("shipments.chooseCourier"));
    if (!selected || !readiness?.canCreateShipment) return void toast.error(blocker || t("shipments.courierNotReady"));
    if (missingArea) return void toast.error(t("shipments.needsArea"));
    mutation.mutate({ orderId: order.id, providerId, options: {} });
  };

  return (
    <section className="space-y-2 border-t pt-4">
      <OperationalReadNotice
        read={read}
        label={t("shipments.couriersFailed")}
        onRetry={() => void queryClient.refetchQueries({ queryKey: queryKeys.settings.deliveryProviders(), type: "active" })}
      />
      {read.status !== "loading" && read.status !== "unavailable" ? (
        providers.length > 0 ? (
          <>
            <Label htmlFor="book-courier">{t("shipments.courier")}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={providerId} onValueChange={setProviderId} disabled={read.status !== "ready" || mutation.isPending || locked}>
                <SelectTrigger id="book-courier" ref={triggerRef}>
                  <SelectValue placeholder={t("shipments.chooseCourier")} />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => {
                    const providerReadiness = resolveProviderReadiness(provider);
                    return (
                      <SelectItem key={provider.id} value={provider.id} disabled={!providerReadiness.canCreateShipment}>
                        {provider.name} · {getProviderReadinessLabel(providerReadiness)}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Button
                className="shrink-0"
                onClick={book}
                disabled={mutation.isPending || !providerId || readiness?.canCreateShipment === false || read.status !== "ready" || locked || missingArea}
              >
                {t("shipments.book")}
              </Button>
            </div>
            {blocker ? <p className="text-muted-foreground">{blocker}</p> : null}
            {missingArea ? (
              <p className="text-muted-foreground">
                {t("shipments.needsArea")}
                {canEditOrder ? (
                  <>
                    {" "}
                    <Link to="/admin/orders/$orderId/edit" params={{ orderId: order.id }} className="text-primary hover:underline">
                      {t("edit")}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">{t("shipments.noCouriers")}</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/settings/shipping">{t("shipments.connectCourier")}</Link>
            </Button>
          </div>
        )
      ) : null}
      <ManualFulfillmentDialog order={order} />
    </section>
  );
}

export function ShipmentCard({ order, bookRequest }: { order: Order; bookRequest?: number }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const queryClient = useQueryClient();
  const cardRef = useRef<HTMLDivElement>(null);
  const [courierCheckOpen, setCourierCheckOpen] = useState(false);
  const canManage = useOrderActionPermissions().canManageOrderShipments;
  const read = order.operationalReads?.shipments ?? { status: "ready" as const, refreshing: false };
  const shipments = order.shipments ?? [];
  const canBook = canManage
    && order.items.length > 0
    && order.fulfillmentStatus !== "complete"
    && canTransitionTo("order", order.status, "shipped");
  const refreshBlockedReason = order.activeRefundOperation?.active
    ? t("locked.refund")
    : order.shipmentRecovery?.activeLock ? t("locked.shipment") : undefined;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(order.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.orders.shipments(order.id) });
  };

  useEffect(() => {
    if (bookRequest) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [bookRequest]);

  return (
    <Card ref={cardRef} id="order-shipments" className="scroll-mt-4">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("shipments.title")}</CardTitle>
        {order.fulfillmentStatus ? (
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
                  canManage={canManage}
                  refreshBlockedReason={refreshBlockedReason}
                  onUpdated={refresh}
                />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{t("shipments.empty")}</p>
          )
        ) : null}
        {canBook ? <BookCourier order={order} focusRequest={bookRequest} /> : null}
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
