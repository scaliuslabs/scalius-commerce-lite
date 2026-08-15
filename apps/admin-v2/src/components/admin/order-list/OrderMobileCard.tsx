import React from "react";
import { Link } from "@tanstack/react-router";
import {
  getOrderArchiveStatusBlockedReason,
} from "@scalius/core/modules/orders/order-archive-policy";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";

/** Minimal shipment shape used in the order list — compatible with ShipmentStatus */
interface OrderShipment {
  id: string;
  orderId: string;
  status?: unknown;
  providerId?: unknown;
  providerType?: unknown;
  trackingId?: unknown;
  lastChecked?: unknown;
  [key: string]: unknown;
}
import { Card, CardContent } from "../../ui/card";
import { Checkbox } from "../../ui/checkbox";
import { Badge } from "../../ui/badge";
import {
  FulfillmentStatusBadge,
  PaymentStatusBadge,
} from "../shared/StatusBadges";
import { Button } from "../../ui/button";
import {
  Phone,
  Mail,
  MapPin,
  Eye,
  Pencil,
  Undo,
  Archive,
  Check,
} from "lucide-react";
import { OrderStatusSelector } from "./OrderStatusSelector";
import { LazyOrderItemsPopover } from "./LazyOrderItemsPopover";
import {
  PaymentRecoveryBadge,
  RefundRecoveryBadge,
  ShipmentRecoveryBadge,
} from "./PaymentRecoveryBadge";
import ShipmentStatusIndicator from "../ShipmentStatusIndicator";
import { LazyFraudCheckIndicator } from "./LazyFraudCheckIndicator";
import { useCurrency } from "@/hooks/use-currency";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatRelativeDate } from "@scalius/shared/timestamps";
import type { OrderActionPermissions } from "@/lib/order-action-permissions";
import { canRefreshShipment } from "@/lib/shipment-action-policy";

interface OrderMobileCardProps {
  order: OrderListItem;
  shipment: OrderShipment | undefined;
  isSelected: boolean;
  isUpdatingStatus: boolean;
  showTrashed: boolean;
  onToggleSelection: (id: string) => void;
  onEdit: (id: string) => void;
  onArchive: (id: string, expectedVersion: number) => void;
  onRestore: (id: string, expectedVersion: number) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  onShipmentStatusUpdated: (updatedShipment: { id: string; orderId: string; [key: string]: unknown }) => void;
  orderActions: OrderActionPermissions;
}

const formatDate = formatRelativeDate;

function PaymentMethodLabel({ method }: { method: string }) {
  const label =
    method === "cod"
      ? "COD"
      : method === "stripe"
        ? "Stripe"
        : method === "sslcommerz"
          ? "SSL"
          : method === "polar"
            ? "Polar"
            : method;

  return (
    <span className="text-xs uppercase leading-4 text-[var(--muted-foreground)]">
      {label}
    </span>
  );
}

export const OrderMobileCard = React.memo(function OrderMobileCard({
  order,
  shipment,
  isSelected,
  isUpdatingStatus,
  showTrashed,
  onToggleSelection,
  onEdit,
  onArchive,
  onRestore,
  onStatusUpdate,
  onShipmentStatusUpdated,
  orderActions,
}: OrderMobileCardProps) {
  const { symbol } = useCurrency();
  const hasPaymentRecovery =
    order.paymentRecovery != null && order.paymentRecovery.state !== "none";
  const hasActivePaymentSetup = order.paymentRecovery?.activeProcessing === true;
  const hasActiveRefundOperation = order.activeRefundOperation?.active === true;
  const hasShipmentRecovery =
    order.shipmentRecovery != null && order.shipmentRecovery.state !== "none";
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const archiveStatusReason = getOrderArchiveStatusBlockedReason(order.status);
  const archiveBlockedReason = archiveStatusReason
    ?? (hasActivePaymentSetup
      ? "Wait for active payment setup before archiving"
      : hasActiveRefundOperation
        ? "Resolve refund recovery before archiving"
        : shipmentLocked
          ? "Resolve shipment recovery before archiving"
          : null);
  const hasRecoveryLock =
    hasPaymentRecovery || hasActiveRefundOperation || hasShipmentRecovery;
  const customerRoute = orderActions.canEditOrders
    ? hasRecoveryLock || !order.fullEditReadiness.allowed
      ? "/admin/orders/$orderId"
      : "/admin/orders/$orderId/edit"
    : "/admin/orders/$orderId";
  return (
    <Card
      className={`mb-3 overflow-hidden border transition-all duration-200 ${
        isSelected
          ? "border-primary ring-2 ring-primary/20"
          : "border-[var(--border)]"
      } ${
        order.status.toLowerCase() === "delivered"
          ? "border-l-4 border-l-emerald-500"
          : order.status.toLowerCase() === "shipped"
            ? "border-l-4 border-l-violet-500"
            : order.status.toLowerCase() === "processing"
              ? "border-l-4 border-l-blue-500"
              : ""
      }`}
    >
      <CardContent className="p-4">
        {/* Header Row */}
        <div className="mb-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2">
          {orderActions.canSelectOrdersForBulkActions && !showTrashed ? (
            <div className="relative -ml-3 -mt-2 h-11 w-11 shrink-0">
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onToggleSelection(order.id)}
                className="absolute inset-0 z-10 h-11 w-11 cursor-pointer rounded-md border-0 bg-transparent text-transparent shadow-none data-[state=checked]:bg-transparent data-[state=checked]:text-transparent"
                aria-label={`Select order ${order.id}`}
              />
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute left-3 top-3 flex h-5 w-5 items-center justify-center rounded border shadow-sm ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-primary bg-background"
                }`}
              >
                {isSelected ? <Check className="h-4 w-4" /> : null}
              </span>
            </div>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="min-w-0">
            <Link
              to={customerRoute}
              params={{ orderId: order.id }}
              className="line-clamp-2 break-words text-base font-semibold text-[var(--foreground)] transition-colors hover:text-primary"
            >
              {order.customerName}
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">
                ID: {order.id.slice(0, 8)}
              </Badge>
              <LazyOrderItemsPopover
                orderId={order.id}
                itemCount={order.itemCount}
              />
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-base font-bold text-[var(--foreground)]">
              {symbol}{order.totalAmount.toLocaleString()}
            </div>
            {(order.discountAmount ?? 0) > 0 && (
              <Badge variant="secondary" className="text-xs mt-1">
                -{symbol}{(order.discountAmount ?? 0).toLocaleString()}
              </Badge>
            )}
          </div>
        </div>

        <div
          className="mb-3 flex flex-wrap items-center gap-1"
          aria-label="Payment and fulfillment"
        >
          <PaymentStatusBadge status={order.paymentStatus} />
          <FulfillmentStatusBadge status={order.fulfillmentStatus} />
          <PaymentMethodLabel method={order.paymentMethod} />
          <PaymentRecoveryBadge recovery={order.paymentRecovery} compact />
          <RefundRecoveryBadge operation={order.activeRefundOperation} compact />
          <ShipmentRecoveryBadge recovery={order.shipmentRecovery} compact />
        </div>

        {/* Contact Info */}
        <div className="space-y-1.5 mb-3">
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <Phone className="h-3.5 w-3.5 shrink-0" />
            <span>{formatPhoneForDisplay(order.customerPhone)}</span>
            <LazyFraudCheckIndicator
              phone={order.customerPhone}
              orderId={order.id}
            />
          </div>
          {order.customerEmail && (
            <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{order.customerEmail}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {order.cityName || order.city}, {order.zoneName || order.zone}
              {(order.areaName || order.area) &&
                `, ${order.areaName || order.area}`}
            </span>
          </div>
        </div>

        {/* Status and Shipment */}
        <div className="flex flex-wrap items-center gap-3 mb-3 pb-3 border-b border-[var(--border)]">
          <OrderStatusSelector
            status={order.status}
            orderId={order.id}
            isLoading={isUpdatingStatus}
            showTrashed={showTrashed}
            canChangeStatus={
              orderActions.canChangeOrderStatus &&
              !hasActiveRefundOperation &&
              !shipmentLocked
            }
            disabledReason={
              hasActiveRefundOperation
                ? "Complete or reconcile the refund before changing this order."
                : shipmentLocked
                  ? order.shipmentRecovery?.message ?? "Resolve shipment recovery before changing this order."
                : undefined
            }
            onStatusUpdate={onStatusUpdate}
          />
          {shipment ? (
            <div className="flex-1 min-w-[200px]">
              <ShipmentStatusIndicator
                shipment={{
                  id: shipment.id,
                  status: shipment.status as string,
                  orderId: order.id,
                  lastChecked:
                    shipment.lastChecked instanceof Date
                      ? (shipment.lastChecked as Date).toISOString()
                      : typeof shipment.lastChecked === "string"
                        ? (shipment.lastChecked as string)
                        : undefined,
                }}
                onStatusUpdated={onShipmentStatusUpdated}
                canRefresh={
                  orderActions.canManageOrderShipments &&
                  canRefreshShipment({
                    providerId:
                      typeof shipment.providerId === "string"
                        ? shipment.providerId
                        : null,
                    providerType:
                      typeof shipment.providerType === "string"
                        ? shipment.providerType
                        : null,
                  }) &&
                  !shipmentLocked
                }
                refreshDisabledReason={
                  shipmentLocked
                    ? order.shipmentRecovery?.message ?? "Resolve shipment recovery before refreshing status."
                    : undefined
                }
              />
            </div>
          ) : (
            <span className="text-xs text-[var(--muted-foreground)]">
              No shipment
            </span>
          )}
        </div>

        {/* Footer - Date and Actions */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--muted-foreground)]" suppressHydrationWarning>
            {formatDate(order.createdAt)}
          </span>
          <div className="flex items-center gap-1">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-11 w-11 p-0 sm:h-8 sm:w-8"
            >
              <Link
                to="/admin/orders/$orderId"
                params={{ orderId: order.id }}
                aria-label={`View order ${order.id}`}
              >
                <Eye className="h-4 w-4" />
              </Link>
            </Button>

            {!showTrashed && orderActions.canEditOrders && order.fullEditReadiness.allowed && !hasActiveRefundOperation && !shipmentLocked && (
              <Button
                variant="ghost"
                size="sm"
                className="h-11 w-11 p-0 sm:h-8 sm:w-8"
                onClick={() => onEdit(order.id)}
                aria-label={`Edit order ${order.id}`}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}

            {showTrashed ? (
              <>
                {orderActions.canRestoreOrders && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-11 w-11 p-0 text-primary sm:h-8 sm:w-8"
                    onClick={() => onRestore(order.id, order.version)}
                    aria-label={`Restore order ${order.id}`}
                  >
                    <Undo className="h-4 w-4" />
                  </Button>
                )}
              </>
            ) : orderActions.canDeleteOrders && archiveBlockedReason ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-11 w-11 cursor-not-allowed p-0 text-[var(--muted-foreground)] sm:h-8 sm:w-8"
                title={
                  archiveBlockedReason
                }
                aria-label={`Archive order ${order.id}: ${archiveBlockedReason}`}
                disabled
              >
                <Archive className="h-4 w-4" />
              </Button>
            ) : orderActions.canDeleteOrders ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-11 w-11 p-0 text-destructive sm:h-8 sm:w-8"
                onClick={() => onArchive(order.id, order.version)}
                aria-label={`Archive order ${order.id}`}
              >
                <Archive className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
