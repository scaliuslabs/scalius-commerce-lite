import React from "react";
import type { OrderListItem } from "../../../lib/admin";
import { Card, CardContent } from "../../ui/card";
import { Checkbox } from "../../ui/checkbox";
import { Badge } from "../../ui/badge";
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
import { OrderItemsPopover } from "./OrderItemsPopover";
import ShipmentStatusIndicator from "../ShipmentStatusIndicator";
import { FraudCheckIndicator } from "./FraudCheckIndicator";

interface OrderMobileCardProps {
  order: OrderListItem;
  shipment: any;
  isSelected: boolean;
  isUpdatingStatus: boolean;
  showTrashed: boolean;
  onToggleSelection: (id: string, shiftKey?: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  onShipmentStatusUpdated: (updatedShipment: any) => void;
}

const formatDate = (date: Date) => {
  try {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
      return "Invalid date";
    }

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 1) {
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours < 1) {
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        return diffMinutes < 1 ? "Just now" : `${diffMinutes}m ago`;
      }
      return `${diffHours}h ago`;
    }

    if (diffDays < 7) {
      return date.toLocaleString("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }

    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: now.getFullYear() !== date.getFullYear() ? "numeric" : undefined,
    });
  } catch (error) {
    return "Invalid date";
  }
};

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
                if (e.shiftKey) {
                  e.preventDefault();
                }
                onToggleSelection(order.id, e.shiftKey);
              }}
              className="cursor-pointer mt-0.5 select-none"
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => {}}
                className="cursor-pointer pointer-events-none"
                aria-label={`Select order ${order.id}. Hold Shift to select range`}
              />
            </div>
            <div>
              <a
                href={`/admin/orders/${order.id}/edit`}
                className="text-base font-semibold text-[var(--foreground)] hover:text-primary transition-colors"
              >
                {order.customerName}
              </a>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <Badge variant="outline" className="text-xs">
                  ID: {order.id.slice(0, 8)}
                </Badge>
                <OrderItemsPopover
                  orderId={order.id}
                  itemCount={order.itemCount}
                />
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-bold text-[var(--foreground)]">
              ৳{order.totalAmount.toLocaleString()}
            </div>
            {(order.discountAmount ?? 0) > 0 && (
              <Badge variant="secondary" className="text-xs mt-1">
                -৳{(order.discountAmount ?? 0).toLocaleString()}
              </Badge>
            )}
          </div>
        </div>

        {/* Contact Info */}
        <div className="space-y-1.5 mb-3">
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <Phone className="h-3.5 w-3.5 shrink-0" />
            <span>{order.customerPhone}</span>
            <FraudCheckIndicator
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
                  status: shipment.status,
                  orderId: order.id,
                  lastChecked:
                    shipment.lastChecked instanceof Date
                      ? shipment.lastChecked.toISOString()
                      : typeof shipment.lastChecked === "string"
                        ? shipment.lastChecked
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
          <span className="text-xs text-[var(--muted-foreground)]">
            {formatDate(order.createdAt)}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() =>
                (window.location.href = `/admin/orders/${order.id}`)
              }
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
