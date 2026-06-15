import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import type { OrderListItem } from "@scalius/core/modules/orders";
import { Badge } from "~/components/ui/badge";
import { PaymentStatusBadge } from "~/components/admin/shared/StatusBadges";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
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
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import {
  formatRelativeDate,
  formatDateVerbose,
} from "@scalius/shared/timestamps";
import { LazyOrderItemsPopover } from "~/components/admin/order-list/LazyOrderItemsPopover";
import { OrderStatusSelector } from "~/components/admin/order-list/OrderStatusSelector";
import ShipmentStatusIndicator from "~/components/admin/ShipmentStatusIndicator";
import { LazyFraudCheckIndicator } from "~/components/admin/order-list/LazyFraudCheckIndicator";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn } from "./column-factories";

/** Minimal shipment shape used in the order list */
interface OrderShipment {
  id: string;
  orderId: string;
  status?: unknown;
  providerType?: unknown;
  trackingId?: unknown;
  lastChecked?: unknown;
  [key: string]: unknown;
}

interface OrderColumnOptions {
  showTrashed: boolean;
  symbol: string;
  shipmentStatuses: Record<string, OrderShipment>;
  updatingStatusIds: Set<string>;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  onShipmentStatusUpdated: (updatedShipment: {
    id: string;
    orderId: string;
    [key: string]: unknown;
  }) => void;
}

// PaymentStatusBadge imported from shared StatusBadges registry

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
    <span className="text-[10px] text-[var(--muted-foreground)] uppercase">
      {label}
    </span>
  );
}

export function getOrderColumns(
  opts: OrderColumnOptions,
): ColumnDef<OrderListItem, unknown>[] {
  return [
    // ── Select ────────────────────────────────────────────────────
    createSelectColumn<OrderListItem>({ getLabel: (r) => (r as OrderListItem).customerName }),

    // ── Customer ──────────────────────────────────────────────────
    {
      accessorKey: "customerName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Customer" />
      ),
      cell: ({ row }) => {
        const order = row.original;
        return (
          <div className="space-y-1.5 max-w-[300px]">
            <div className="flex items-center gap-1.5">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/admin/orders/${order.id}/edit` as string}
                      className="group/link text-sm font-semibold text-[var(--foreground)] transition-all duration-200 hover:text-primary hover:underline"
                    >
                      {order.customerName}
                    </Link>
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
              <span className="flex items-center gap-1 rounded-full bg-[var(--muted)]/70 px-2 py-0.5">
                <Phone className="h-3 w-3" />
                {formatPhoneForDisplay(order.customerPhone)}
              </span>
              {order.customerEmail && (
                <span className="flex items-center gap-1 rounded-full bg-[var(--muted)]/70 px-2 py-0.5">
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
              <LazyFraudCheckIndicator
                phone={order.customerPhone}
                orderId={order.id}
              />
            </div>
          </div>
        );
      },
      size: 300,
    },

    // ── Items ─────────────────────────────────────────────────────
    {
      id: "items",
      header: () => <span>Items</span>,
      cell: ({ row }) => (
        <LazyOrderItemsPopover
          orderId={row.original.id}
          itemCount={row.original.itemCount}
        />
      ),
      enableSorting: false,
    },

    // ── Amount ────────────────────────────────────────────────────
    {
      accessorKey: "totalAmount",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Amount" />
      ),
      cell: ({ row }) => {
        const order = row.original;
        return (
          <div className="space-y-1.5">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {opts.symbol}
              {order.totalAmount.toLocaleString()}
            </span>
            {(order.discountAmount ?? 0) > 0 && (
              <div className="flex items-center gap-1 text-xs">
                <Badge
                  variant="secondary"
                  className="bg-[var(--muted)] text-[var(--muted-foreground)]"
                >
                  -{opts.symbol}
                  {(order.discountAmount ?? 0).toLocaleString()}
                </Badge>
              </div>
            )}
            <div className="flex items-center gap-1">
              <PaymentStatusBadge status={order.paymentStatus} />
              <PaymentMethodLabel method={order.paymentMethod} />
            </div>
          </div>
        );
      },
    },

    // ── Status ────────────────────────────────────────────────────
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => {
        const order = row.original;
        return (
          <OrderStatusSelector
            status={order.status}
            orderId={order.id}
            isLoading={opts.updatingStatusIds.has(order.id)}
            showTrashed={opts.showTrashed}
            onStatusUpdate={opts.onStatusUpdate}
          />
        );
      },
    },

    // ── Shipment ──────────────────────────────────────────────────
    {
      id: "shipment",
      header: () => <span>Shipment</span>,
      cell: ({ row }) => {
        const order = row.original;
        const shipment = opts.shipmentStatuses[order.id];

        if (!shipment) {
          return (
            <span className="text-xs text-[var(--muted-foreground)]">
              No shipment
            </span>
          );
        }

        const provType = shipment.providerType as string | undefined;
        const trkId = shipment.trackingId as string | null | undefined;
        const trackingUrl =
          provType === "pathao"
            ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(trkId || "")}`
            : provType === "steadfast"
              ? `https://steadfast.com.bd/t/${encodeURIComponent(trkId || "")}`
              : null;

        return (
          <div className="flex flex-col gap-2 relative z-10">
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
              onStatusUpdated={opts.onShipmentStatusUpdated}
            />
            {trkId && trackingUrl && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1">
                <a
                  href={trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="font-mono truncate max-w-[90px]">
                    {trkId}
                  </span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        );
      },
      enableSorting: false,
    },

    // ── Date ──────────────────────────────────────────────────────
    {
      accessorKey: "createdAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Date" />
      ),
      cell: ({ row }) => {
        const order = row.original;
        return (
          <div className="flex flex-col gap-0.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="cursor-default text-xs font-medium text-[var(--foreground)]"
                    suppressHydrationWarning
                  >
                    {formatRelativeDate(order.createdAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="center"
                  className="max-w-fit text-xs"
                  suppressHydrationWarning
                >
                  {formatDateVerbose(order.createdAt)}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        );
      },
    },

    // ── Actions ───────────────────────────────────────────────────
    {
      id: "actions",
      header: () => (
        <span className="text-right block pr-2">Actions</span>
      ),
      cell: ({ row }) => {
        const order = row.original;
        return (
          <div className="flex items-center justify-end gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={`/admin/orders/${order.id}` as string}
                    className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--primary)] transition-all duration-200 hover:bg-[var(--muted)]/80 hover:scale-105 hover:shadow-sm active:scale-95"
                  >
                    <Eye className="h-4 w-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent>View Details</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {!opts.showTrashed && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => opts.onEdit(order.id)}
                      className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--primary)] transition-all duration-200 hover:bg-[var(--muted)]/80 hover:scale-105 hover:shadow-sm active:scale-95"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Edit Order</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {opts.showTrashed ? (
              <>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => opts.onRestore(order.id)}
                        className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--primary)] transition-all duration-200 hover:bg-[var(--muted)]/80 hover:scale-105 hover:shadow-sm active:scale-95"
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
                        onClick={() => opts.onPermanentDelete(order.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--destructive)]/10 text-[var(--destructive)] transition-all duration-200 hover:bg-[var(--destructive)]/20 hover:scale-105 hover:shadow-sm active:scale-95"
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
                      onClick={() => opts.onDelete(order.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--destructive)]/10 text-[var(--destructive)] transition-all duration-200 hover:bg-[var(--destructive)]/20 hover:scale-105 hover:shadow-sm active:scale-95"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Move to Trash</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        );
      },
      enableSorting: false,
      size: 100,
    },
  ];
}
