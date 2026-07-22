import React from "react";
import { Link } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AlertTriangle, Truck, ChevronDown, ChevronUp, Loader2, ExternalLink, RefreshCw } from "lucide-react";
import { ShipmentMetadataDisplay } from "@/components/ui/ShipmentMetadataDisplay";
import ShipmentStatusIndicator from "@/components/admin/ShipmentStatusIndicator";
import type { Order, OrderShipment } from "./types";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateOrderShipment, useReconcileShipment } from "@/lib/api-mutations/orders";
import { queryKeys } from "@/lib/query-keys";
import { ManualFulfillmentDialog } from "./ManualFulfillmentDialog";
import { formatOrderDate } from "./formatters";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import {
  getProviderReadinessLabel,
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "@/components/admin/delivery-providers/ProviderIcon";

interface ShipmentCardProps {
  order: Order;
}

const CreateShipmentForm = ({
  order,
}: {
  order: Order;
}) => {
  const queryClient = useQueryClient();
  const [selectedProviderId, setSelectedProviderId] = React.useState("");
  const shipmentMutation = useCreateOrderShipment();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const deliveryProviders = order.deliveryProviders ?? [];
  const selectedProvider = deliveryProviders.find(
    (provider) => provider.id === selectedProviderId,
  );
  const selectedReadiness = selectedProvider
    ? resolveProviderReadiness(selectedProvider)
    : null;
  const selectedProviderBlocker = selectedReadiness &&
    !selectedReadiness.canCreateShipment
      ? getProviderReadinessMessage(selectedReadiness)
      : "";
  const readyProviderCount = deliveryProviders.filter(
    (provider) => resolveProviderReadiness(provider).canCreateShipment,
  ).length;
  const providersRead = order.operationalReads?.deliveryProviders ?? {
    status: "ready" as const,
    refreshing: false,
  };

  const retryProviders = () => {
    void queryClient.refetchQueries({
      queryKey: queryKeys.settings.deliveryProviders(),
      type: "active",
    });
  };

  const handleCreateShipment = () => {
    if (refundLocked) {
      toast.error("Order locked", { description: "Complete or reconcile the active refund before creating shipments." });
      return;
    }
    if (shipmentLocked) {
      toast.error("Shipment recovery active", { description: order.shipmentRecovery?.message ?? "Resolve the active shipment recovery before creating another shipment." });
      return;
    }
    if (!selectedProviderId) {
      toast.error("Error", { description: "Please select a delivery provider." });
      return;
    }
    if (!selectedProvider || !selectedReadiness?.canCreateShipment) {
      toast.error("Provider cannot create shipments", {
        description: selectedProviderBlocker ||
          "Complete provider setup before creating shipments.",
      });
      return;
    }
    shipmentMutation.mutate({
      orderId: order.id,
      shipment: { providerId: selectedProviderId, options: {} },
    });
  };

  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-4 w-4" />
          Create Shipment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {order.activeRefundOperation && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{order.activeRefundOperation.message}</span>
            </div>
          </div>
        )}
        <div className="space-y-3">
          {providersRead.status === "loading" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading delivery providers…
            </div>
          ) : providersRead.status === "unavailable" ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Delivery providers unavailable</p>
                  <p className="mt-1 text-xs opacity-90">Provider shipment creation is paused until setup can be verified.</p>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-11 shrink-0 px-2 text-xs sm:h-7" onClick={retryProviders} disabled={providersRead.refreshing}>
                  {providersRead.refreshing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <>
              {providersRead.status === "stale" ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">Showing the last loaded provider setup. Retry before creating a shipment.</span>
                  <Button type="button" variant="outline" size="sm" className="h-11 shrink-0 px-2 text-xs sm:h-7" onClick={retryProviders} disabled={providersRead.refreshing}>
                    {providersRead.refreshing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Retry
                  </Button>
                </div>
              ) : null}
              {deliveryProviders.length > 0 ? (
                <>
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Select Delivery Provider
                </label>
                <Select
                  value={selectedProviderId}
                  onValueChange={setSelectedProviderId}
                  disabled={
                    providersRead.status !== "ready" ||
                    shipmentMutation.isPending ||
                    refundLocked ||
                    shipmentLocked
                  }
                >
                  <SelectTrigger
                    aria-label="Delivery provider"
                    className="h-11 border-border bg-background text-sm text-foreground sm:h-9"
                  >
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    {deliveryProviders.map((provider) => (
                      <SelectItem
                        key={provider.id}
                        value={provider.id}
                        disabled={!resolveProviderReadiness(provider).canCreateShipment}
                        className="text-foreground"
                      >
                        {provider.name} - {getProviderReadinessLabel(resolveProviderReadiness(provider))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProviderBlocker && (
                  <p className="rounded-md border border-amber-200 bg-amber-50/80 p-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
                    {selectedProviderBlocker}
                  </p>
                )}
                {readyProviderCount === 0 && (
                  <p className="rounded-md border border-amber-200 bg-amber-50/80 p-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
                    No shipment-ready providers.{" "}
                    {getProviderReadinessMessage(resolveProviderReadiness(deliveryProviders[0]!))}
                  </p>
                )}
              </div>
              <Button
                className="min-h-11 w-full sm:min-h-10"
                disabled={
                  shipmentMutation.isPending ||
                  !selectedProviderId ||
                  selectedReadiness?.canCreateShipment === false ||
                  providersRead.status !== "ready" ||
                  refundLocked ||
                  shipmentLocked
                }
                onClick={handleCreateShipment}
              >
                {shipmentMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {shipmentMutation.isPending ? "Creating..." : "Create Shipment"}
              </Button>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 p-3 text-sm">
                  <div>
                    <p className="font-medium">No delivery providers configured</p>
                    <p className="mt-1 text-xs text-muted-foreground">Add a provider for tracked courier shipments.</p>
                  </div>
                  <Button asChild type="button" variant="outline" size="sm" className="h-11 sm:h-8">
                    <Link to="/admin/settings/delivery-providers">Configure providers</Link>
                  </Button>
                </div>
              )}
            </>
          )}
          <ManualFulfillmentDialog order={order} />
        </div>
      </CardContent>
    </Card>
  );
};

const SHIPMENT_RECOVERY_CLASS = {
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-200",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200",
  danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200",
} as const;

function ShipmentRecoveryNotice({
  order,
  canManageShipments,
}: {
  order: Order;
  canManageShipments: boolean;
}) {
  const recovery = order.shipmentRecovery;
  const reconcileMutation = useReconcileShipment();
  if (!recovery || recovery.state === "none") return null;
  const canRepair =
    canManageShipments &&
    recovery.state === "needs_attention" &&
    recovery.activeLock &&
    Boolean(recovery.shipmentId);

  const handleRepair = () => {
    if (!recovery.shipmentId) return;
    reconcileMutation.mutate({
      orderId: order.id,
      shipmentId: recovery.shipmentId,
    });
  };

  return (
    <div className={`mt-6 rounded-lg border p-3 text-sm ${SHIPMENT_RECOVERY_CLASS[recovery.severity]}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{recovery.label}</p>
          {recovery.message && <p className="mt-1 text-xs opacity-90">{recovery.message}</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-80">
            {recovery.status && <span>Status: {recovery.status.replaceAll("_", " ")}</span>}
            {recovery.providerType && <span>Provider: {recovery.providerType}</span>}
            {recovery.canRetryCreate && <span>Retry: create a new shipment after fixing setup.</span>}
            {recovery.canRefresh && <span>Refresh can retry provider status sync.</span>}
          </div>
        </div>
        </div>
        {canRepair && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 border-current/30 bg-background/70 px-3 text-xs hover:bg-background"
            disabled={reconcileMutation.isPending}
            onClick={handleRepair}
          >
            {reconcileMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {reconcileMutation.isPending ? "Repairing..." : "Repair shipment"}
          </Button>
        )}
      </div>
    </div>
  );
}

const ShipmentHistoryItem = ({
  shipment,
  orderId,
  onStatusUpdated,
  canManageShipments,
  refreshDisabledReason,
}: {
  shipment: OrderShipment;
  orderId: string;
  onStatusUpdated: () => void;
  canManageShipments: boolean;
  refreshDisabledReason?: string;
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const hasRefreshableProvider = Boolean(shipment.providerId);
  const canRefreshShipment =
    canManageShipments && hasRefreshableProvider && !refreshDisabledReason;

  return (
    <div key={shipment.id} className="p-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col">
          <span className="mb-1 text-xs text-muted-foreground">
            {formatOrderDate(shipment.createdAt) ?? "N/A"}
          </span>
          <ShipmentStatusIndicator
            shipment={{
              id: shipment.id,
              status: shipment.status,
              orderId: orderId,
              lastChecked:
                shipment.lastChecked instanceof Date
                  ? shipment.lastChecked.toISOString()
                  : typeof shipment.lastChecked === "string"
                    ? shipment.lastChecked
                    : typeof shipment.lastChecked === "number"
                      ? new Date(shipment.lastChecked).toISOString()
                    : undefined,
            }}
            onStatusUpdated={onStatusUpdated}
            canRefresh={canRefreshShipment}
            showLastChecked={hasRefreshableProvider}
            refreshDisabledReason={
              canManageShipments && hasRefreshableProvider
                ? refreshDisabledReason
                : undefined
            }
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-8 w-8 p-0 text-foreground hover:bg-muted/50 hover:text-primary"
        >
          {isExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="mt-3 space-y-1 border-t border-border pt-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Provider:</span>
          <span className="text-foreground">
            {shipment.providerName ?? shipment.courierName ?? shipment.providerType}
          </span>
        </div>
        {shipment.courierName && shipment.courierName !== shipment.providerName && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Courier:</span>
            <span className="text-foreground">{shipment.courierName}</span>
          </div>
        )}
        {shipment.trackingId && (() => {
          const trackingUrl = shipment.trackingUrl ?? (shipment.providerType === "pathao"
            ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(shipment.trackingId)}`
            : shipment.providerType === "steadfast"
              ? `https://steadfast.com.bd/t/${encodeURIComponent(shipment.trackingId)}`
              : null);

          return (
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Tracking ID:</span>
              <div className="flex flex-col items-end gap-1">
                <span className="font-mono text-xs">{shipment.trackingId}</span>
                {trackingUrl && (
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
                    <a href={trackingUrl} target="_blank" rel="noopener noreferrer">
                      View Courier Tracking <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
          );
        })()}
        {shipment.note && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Note:</span>
            <span className="text-right text-foreground">{shipment.note}</span>
          </div>
        )}
      </div>

      {isExpanded && shipment.metadata && (
        <div className="mt-3 border-t border-border pt-3">
          <h4 className="mb-2 text-sm font-medium text-foreground">
            Detailed Information
          </h4>
          <ShipmentMetadataDisplay metadata={shipment.metadata} />
        </div>
      )}
    </div>
  );
};

export function ShipmentCard({ order }: ShipmentCardProps) {
  const queryClient = useQueryClient();
  const orderActions = useOrderActionPermissions();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(order.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.orders.shipments(order.id) });
  };

  const hasCreateShipmentActions =
    orderActions.canManageOrderShipments && order.items.length > 0;
  const hasShipments = order.shipments && order.shipments.length > 0;
  const shipmentsRead = order.operationalReads?.shipments ?? {
    status: "ready" as const,
    refreshing: false,
  };
  const retryShipments = () => {
    void queryClient.refetchQueries({
      queryKey: queryKeys.orders.shipments(order.id),
      type: "active",
    });
  };
  const shipmentRefreshDisabledReason = refundLocked
    ? "Shipment refresh is locked while refund recovery is active."
    : shipmentLocked
      ? order.shipmentRecovery?.message ?? "Shipment refresh is locked while shipment recovery is active."
    : undefined;

  return (
    <>
      <ShipmentRecoveryNotice
        order={order}
        canManageShipments={orderActions.canManageOrderShipments}
      />

      {hasCreateShipmentActions && (
        <CreateShipmentForm order={order} />
      )}

      <Card className="mt-6 overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="h-4 w-4" />
            Shipment History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {shipmentsRead.status === "loading" ? (
            <div className="flex min-h-24 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading shipment history…
            </div>
          ) : shipmentsRead.status === "unavailable" ? (
            <div className="flex min-h-28 flex-col items-center justify-center gap-3 p-4 text-center">
              <div>
                <p className="text-sm font-medium text-destructive">Shipment history unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">Existing shipments were not assumed empty.</p>
              </div>
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={retryShipments} disabled={shipmentsRead.refreshing}>
                {shipmentsRead.refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Retry
              </Button>
            </div>
          ) : (
            <>
              {shipmentsRead.status === "stale" ? (
                <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">Showing the last loaded shipment data. Refresh failed.</span>
                  <Button type="button" size="sm" variant="outline" className="h-11 shrink-0 px-2 text-xs sm:h-7" onClick={retryShipments} disabled={shipmentsRead.refreshing}>
                    {shipmentsRead.refreshing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Retry
                  </Button>
                </div>
              ) : null}
              {hasShipments ? (
                <div className="divide-y divide-border">
              {order.shipments?.map((shipment) => (
                <ShipmentHistoryItem
                  key={shipment.id}
                  shipment={shipment}
                  orderId={order.id}
                  onStatusUpdated={handleRefresh}
                  canManageShipments={orderActions.canManageOrderShipments}
                  refreshDisabledReason={shipmentRefreshDisabledReason}
                />
              ))}
                </div>
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">No shipments yet</p>
                  <p className="mt-1">Create a provider shipment above or record an own-courier fulfillment.</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
