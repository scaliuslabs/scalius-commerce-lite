import React from "react";
import { Link } from "@tanstack/react-router";
import type { OrderListItem } from "@scalius/core/modules/orders";

/** Minimal shipment shape used in the order list — compatible with ShipmentStatus */
interface OrderShipment {
  id: string;
  orderId: string;
  status?: unknown;
  providerType?: unknown;
  trackingId?: unknown;
  lastChecked?: unknown;
  [key: string]: unknown;
}
import { Card, CardContent } from "../../ui/card";
import { Checkbox } from "../../ui/checkbox";
import { Badge } from "../../ui/badge";
import { PaymentStatusBadge } from "../shared/StatusBadges";
import { Button } from "../../ui/button";
import {
  Phone,
  Mail,
  MapPin,
  Eye,
  Pencil,
  Undo,
  XCircle,
  Trash2,
} from "lucide-react";
import { OrderStatusSelector } from "./OrderStatusSelector";
import { LazyOrderItemsPopover } from "./LazyOrderItemsPopover";
import ShipmentStatusIndicator from "../ShipmentStatusIndicator";
import { LazyFraudCheckIndicator } from "./LazyFraudCheckIndicator";
import { useCurrency } from "@/hooks/use-currency";
import { useNavigate } from "@tanstack/react-router";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatRelativeDate } from "@scalius/shared/timestamps";

interface OrderMobileCardProps {
  order: OrderListItem;
  shipment: OrderShipment | undefined;
  isSelected: boolean;
  isUpdatingStatus: boolean;
  showTrashed: boolean;
  onToggleSelection: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  onShipmentStatusUpdated: (updatedShipment: { id: string; orderId: string; [key: string]: unknown }) => void;
}

const formatDate = formatRelativeDate;

export const OrderMobileCard = React.memo(function OrderMobileCard({
  order,
  shipment,
  isSelected,
  isUpdatingStatus,
  showTrashed,
  onToggleSelection,
  onEdit,
  onDelete,
  onPermanentDelete,
  onRestore,
  onStatusUpdate,
  onShipmentStatusUpdated,
}: OrderMobileCardProps) {
  const navigate = useNavigate();
  const { symbol } = useCurrency();
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
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-3">
            <div
              onClick={(e) => {
                e.preventDefault();
                onToggleSelection(order.id);
              }}
              className="cursor-pointer mt-0.5 select-none"
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => {}}
                className="cursor-pointer pointer-events-none"
                aria-label={`Select order ${order.id}`}
              />
            </div>
            <div>
              <Link
                to={`/admin/orders/${order.id}/edit` as string}
                className="text-base font-semibold text-[var(--foreground)] hover:text-primary transition-colors"
              >
                {order.customerName}
              </Link>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <Badge variant="outline" className="text-xs">
                  ID: {order.id.slice(0, 8)}
                </Badge>
                <LazyOrderItemsPopover
                  orderId={order.id}
                  itemCount={order.itemCount}
                />
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-bold text-[var(--foreground)]">
              {symbol}{order.totalAmount.toLocaleString()}
            </div>
            {(order.discountAmount ?? 0) > 0 && (
              <Badge variant="secondary" className="text-xs mt-1">
                -{symbol}{(order.discountAmount ?? 0).toLocaleString()}
              </Badge>
            )}
            <div className="flex items-center justify-end gap-1 mt-1">
              <PaymentStatusBadge status={order.paymentStatus} />
              <span className="text-[10px] text-[var(--muted-foreground)] uppercase">
                {order.paymentMethod === "cod" ? "COD" : order.paymentMethod === "stripe" ? "Stripe" : order.paymentMethod === "sslcommerz" ? "SSL" : order.paymentMethod === "polar" ? "Polar" : order.paymentMethod}
              </span>
            </div>
          </div>
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
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => void navigate({ to: `/admin/orders/${order.id}` as string })}
            >
              <Eye className="h-4 w-4" />
            </Button>

            {!showTrashed && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => onEdit(order.id)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}

            {showTrashed ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-primary"
                  onClick={() => onRestore(order.id)}
                >
                  <Undo className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-destructive"
                  onClick={() => onPermanentDelete(order.id)}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-destructive"
                onClick={() => onDelete(order.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
