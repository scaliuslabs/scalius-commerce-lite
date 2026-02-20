import React from "react";
import type { OrderListItem } from "../../../lib/admin";
import { TableCell, TableRow } from "../../ui/table";
import { Checkbox } from "../../ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import { Badge } from "../../ui/badge";
import {
  Phone,
  Mail,
  MapPin,
  Eye,
  Pencil,
  Undo,
  XCircle,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { OrderItemsPopover } from "./OrderItemsPopover";
import { OrderStatusSelector } from "./OrderStatusSelector";
import ShipmentStatusIndicator from "../ShipmentStatusIndicator";
import { FraudCheckIndicator } from "./FraudCheckIndicator";

interface OrderTableRowProps {
  order: OrderListItem;
  shipment: any; // The specific shipment for this order
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
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch (error) {
    console.error("Error formatting date:", error);
    return "Invalid date";
  }
};

const getFullDateTimeString = (date: Date) => {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "Invalid date";
  }

  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
};

export const OrderTableRow = React.memo(function OrderTableRow({
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
}: OrderTableRowProps) {
  const rowClassName = `group border-b border-[var(--border)] transition-colors duration-150 hover:bg-[var(--muted)]/80 ${order.status.toLowerCase() === "delivered"
    ? "border-l-3 border-l-emerald-500"
    : order.status.toLowerCase() === "shipped"
      ? "border-l-3 border-l-violet-500"
      : order.status.toLowerCase() === "processing"
        ? "border-l-3 border-l-blue-500"
        : ""
    }`;

  return (
    <TableRow key={order.id} className={rowClassName}>
      <TableCell className="py-4 pl-4">
        <div
          onClick={(e) => {
            if (e.shiftKey) {
              e.preventDefault();
            }
            onToggleSelection(order.id, e.shiftKey);
          }}
          className="cursor-pointer select-none"
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => { }}
            className="translate-y-[2px] transition-all duration-200 cursor-pointer pointer-events-none"
            aria-label={`Select order ${order.id}. Hold Shift to select range`}
          />
        </div>
      </TableCell>
      <TableCell className="max-w-[300px] py-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={`/admin/orders/${order.id}/edit`}
                    className="group/link text-sm font-semibold text-[var(--foreground)] transition-all duration-200 hover:text-primary hover:underline"
                  >
                    {order.customerName}
                  </a>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="start"
                  className="max-w-[250px] text-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold">ID:</span> {order.id}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1 rounded-full bg-[var(--muted)]/70 px-2 py-0.5 transition-colors duration-200 group-hover:bg-[var(--muted)]">
              <Phone className="h-3 w-3" />
              {order.customerPhone}
            </span>
            {order.customerEmail && (
              <span className="flex items-center gap-1 rounded-full bg-[var(--muted)]/70 px-2 py-0.5 transition-colors duration-200 group-hover:bg-[var(--muted)]">
                <Mail className="h-3 w-3" />
                <span className="max-w-[120px] truncate">
                  {order.customerEmail}
                </span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
              <MapPin className="h-3 w-3" />
              <span className="truncate">
                {order.cityName || order.city},{" "}
                {order.zoneName || order.zone}
                {(order.areaName || order.area) &&
                  `, ${order.areaName || order.area}`}
              </span>
            </div>
            <FraudCheckIndicator phone={order.customerPhone} orderId={order.id} />
          </div>
        </div>
      </TableCell>
      <TableCell className="py-4">
        <OrderItemsPopover orderId={order.id} itemCount={order.itemCount} />
      </TableCell>
      <TableCell className="py-4">
        <div className="space-y-1.5">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            ৳{order.totalAmount.toLocaleString()}
          </span>
          {(order.discountAmount ?? 0) > 0 && (
            <div className="flex items-center gap-1 text-xs">
              <Badge
                variant="secondary"
                className="bg-[var(--muted)] text-[var(--muted-foreground)] transition-all duration-200 hover:bg-[var(--muted)]/80"
              >
                -৳{(order.discountAmount ?? 0).toLocaleString()}
              </Badge>
            </div>
          )}
          <div className="flex items-center gap-1">
            {order.paymentStatus === "paid" ? (
              <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 text-[10px] px-1.5 py-0">
                Paid
              </Badge>
            ) : order.paymentStatus === "partial" ? (
              <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
                Partial
              </Badge>
            ) : order.paymentStatus === "unpaid" ? (
              <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 text-[10px] px-1.5 py-0">
                Unpaid
              </Badge>
            ) : null}
            <span className="text-[10px] text-[var(--muted-foreground)] uppercase">
              {order.paymentMethod === "cod" ? "COD" : order.paymentMethod === "stripe" ? "Stripe" : order.paymentMethod === "sslcommerz" ? "SSL" : order.paymentMethod}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="py-4">
        <OrderStatusSelector
          status={order.status}
          orderId={order.id}
          isLoading={isUpdatingStatus}
          showTrashed={showTrashed}
          onStatusUpdate={onStatusUpdate}
        />
      </TableCell>
      <TableCell className="py-4">
        {shipment ? (() => {
          const trackingUrl = shipment.providerType === "pathao"
            ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(shipment.trackingId || '')}`
            : shipment.providerType === "steadfast"
              ? `https://steadfast.com.bd/t/${encodeURIComponent(shipment.trackingId || '')}`
              : null;

          return (
            <div className="flex flex-col gap-2 relative z-10">
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
              {shipment.trackingId && trackingUrl && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1">
                  <a
                    href={trackingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="font-mono truncate max-w-[90px]">{shipment.trackingId}</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>
          );
        })() : (
          <span className="text-xs text-[var(--muted-foreground)]">
            No shipment
          </span>
        )}
      </TableCell>
      <TableCell className="py-4">
        <div className="flex flex-col gap-0.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-xs font-medium text-[var(--foreground)] transition-all duration-200 group-hover:font-semibold">
                  {formatDate(order.createdAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="center"
                className="max-w-fit text-xs"
              >
                {getFullDateTimeString(order.createdAt)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </TableCell>
      <TableCell className="py-4 pr-4 text-right">
        <div className="flex items-center justify-end gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`/admin/orders/${order.id}`}
                  className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--primary)] transition-all duration-200 hover:bg-[var(--muted)]/80 hover:text-[var(--primary)] hover:scale-105 hover:shadow-sm active:scale-95"
                >
                  <Eye className="h-4 w-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent>View Details</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {!showTrashed && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onEdit(order.id)}
                    className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--primary)] transition-all duration-200 hover:bg-[var(--muted)]/80 hover:text-[var(--primary)] hover:scale-105 hover:shadow-sm active:scale-95"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Edit Order</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {showTrashed ? (
            <>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onRestore(order.id)}
                      className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--primary)] transition-all duration-200 hover:bg-[var(--muted)]/80 hover:text-[var(--primary)] hover:scale-105 hover:shadow-sm active:scale-95"
                    >
                      <Undo className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Restore Order</TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onPermanentDelete(order.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--destructive)]/10 text-[var(--destructive)] transition-all duration-200 hover:bg-[var(--destructive)]/20 hover:text-[var(--destructive)] hover:scale-105 hover:shadow-sm active:scale-95"
                    >
                      <XCircle className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Delete Permanently</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onDelete(order.id)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--destructive)]/10 text-[var(--destructive)] transition-all duration-200 hover:bg-[var(--destructive)]/20 hover:text-[var(--destructive)] hover:scale-105 hover:shadow-sm active:scale-95"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Move to Trash</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
});
