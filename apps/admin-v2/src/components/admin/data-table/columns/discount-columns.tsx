import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  Tag,
  Percent,
  Truck,
  Copy,
  X,
  Check,
  Clock,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { formatPrice } from "@scalius/shared/currency";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createActionsColumn } from "./column-factories";

export interface DiscountItem {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  maxUsesPerOrder: number | null;
  maxUses: number | null;
  limitOnePerCustomer: boolean;
  combineWithProductDiscounts: boolean;
  combineWithOrderDiscounts: boolean;
  combineWithShippingDiscounts: boolean;
  customerSegment: string | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  relatedProducts: { buy: string[]; get: string[] };
  relatedCollections: { buy: string[]; get: string[] };
  usageCount?: number;
  totalDiscountAmount?: number;
}

function getTypeLabel(type: string): string {
  switch (type) {
    case "amount_off_products":
      return "Amount Off Products";
    case "amount_off_order":
      return "Amount Off Order";
    case "free_shipping":
      return "Free Shipping";
    default:
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }
}

function getDiscountValueDisplay(
  discount: DiscountItem,
  symbol: string,
): string {
  switch (discount.valueType) {
    case "percentage":
      return `${discount.discountValue}% off`;
    case "fixed_amount":
      return `${formatPrice(discount.discountValue, { symbol })} off`;
    case "free":
      return "Free";
    default:
      return discount.discountValue.toString();
  }
}

function buildDiscountSummary(
  discount: DiscountItem,
  symbol: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Type: ${getTypeLabel(discount.type)}`);
  lines.push(`Value: ${getDiscountValueDisplay(discount, symbol)}`);
  if (discount.minPurchaseAmount) {
    lines.push(
      `Min purchase: ${symbol}${discount.minPurchaseAmount.toLocaleString()}`,
    );
  }
  if (discount.minQuantity) {
    lines.push(`Min quantity: ${discount.minQuantity}`);
  }
  if (discount.maxUsesPerOrder) {
    lines.push(`Max per order: ${discount.maxUsesPerOrder}`);
  }
  if (discount.limitOnePerCustomer) {
    lines.push("Limit: 1 per customer");
  }
  if (discount.customerSegment) {
    lines.push(`Segment: ${discount.customerSegment}`);
  }
  const combines: string[] = [];
  if (discount.combineWithProductDiscounts) combines.push("product");
  if (discount.combineWithOrderDiscounts) combines.push("order");
  if (discount.combineWithShippingDiscounts) combines.push("shipping");
  if (combines.length > 0) {
    lines.push(`Combines with: ${combines.join(", ")}`);
  }
  return lines;
}

interface DiscountColumnOptions {
  showTrashed: boolean;
  symbol: string;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onToggleStatus: (id: string, currentStatus: boolean) => void;
}

function DiscountStatusCell({
  discount,
  showTrashed,
  onToggleStatus,
}: {
  discount: DiscountItem;
  showTrashed: boolean;
  onToggleStatus: (id: string, currentStatus: boolean) => void;
}) {
  if (showTrashed) {
    return (
      <Badge
        variant="outline"
        className="text-muted-foreground text-xs font-medium px-2 py-0.5 rounded-full"
      >
        Deleted
      </Badge>
    );
  }

  const now = new Date();
  const startDate = discount.startDate ? new Date(discount.startDate) : null;
  const endDate = discount.endDate ? new Date(discount.endDate) : null;
  const isExpired = endDate ? endDate < now : false;
  const isScheduled = startDate ? startDate > now : false;

  if (isExpired) {
    return (
      <Badge
        variant="outline"
        className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900/30 dark:text-gray-400"
      >
        Expired
      </Badge>
    );
  }

  if (isScheduled && discount.isActive) {
    return (
      <Badge
        variant="outline"
        className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400"
      >
        <Clock className="h-3 w-3 mr-1" />
        Scheduled
      </Badge>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="p-0 h-auto hover:bg-transparent"
      onClick={() => onToggleStatus(discount.id, discount.isActive)}
    >
      <Badge
        variant={discount.isActive ? "default" : "outline"}
        className={cn(
          discount.isActive
            ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-700"
            : "text-muted-foreground",
          "text-xs font-medium px-2 py-0.5 rounded-full",
        )}
      >
        {discount.isActive ? "Active" : "Inactive"}
      </Badge>
    </Button>
  );
}

export function getDiscountColumns(
  opts: DiscountColumnOptions,
): ColumnDef<DiscountItem, unknown>[] {
  return [
    createSelectColumn<DiscountItem>({ getLabel: (r) => (r as DiscountItem).code }),
    {
      accessorKey: "code",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Code" />
      ),
      cell: ({ row }) => {
        const discount = row.original;
        const summaryLines = buildDiscountSummary(discount, opts.symbol);
        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 cursor-default">
                  <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate font-semibold text-foreground">
                    {discount.code}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <div className="space-y-1 text-xs">
                  <p className="font-semibold text-sm mb-1.5">
                    {discount.code}
                  </p>
                  {summaryLines.map((line, i) => (
                    <p key={i} className="text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      },
      size: 200,
    },
    {
      accessorKey: "type",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Type" />
      ),
      cell: ({ row }) => {
        const discount = row.original;
        return (
          <Badge
            variant="outline"
            className={cn(
              "text-xs font-medium",
              discount.type === "amount_off_products" &&
                "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-700",
              discount.type === "amount_off_order" &&
                "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-700",
              discount.type === "free_shipping" &&
                "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-700",
            )}
          >
            {discount.type === "amount_off_products" ? (
              <Tag className="h-3 w-3 mr-1" />
            ) : discount.type === "amount_off_order" ? (
              <Percent className="h-3 w-3 mr-1" />
            ) : discount.type === "free_shipping" ? (
              <Truck className="h-3 w-3 mr-1" />
            ) : null}
            {getTypeLabel(discount.type)}
          </Badge>
        );
      },
      size: 140,
    },
    {
      accessorKey: "value",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Value" />
      ),
      cell: ({ row }) => (
        <Badge variant="secondary">
          {getDiscountValueDisplay(row.original, opts.symbol)}
        </Badge>
      ),
      size: 120,
    },
    {
      accessorKey: "startDate",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Start" />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs" suppressHydrationWarning>
          {formatDate(row.original.startDate)}
        </span>
      ),
      size: 110,
    },
    {
      accessorKey: "endDate",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="End" />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs" suppressHydrationWarning>
          {row.original.endDate
            ? formatDate(row.original.endDate)
            : "No end date"}
        </span>
      ),
      size: 110,
    },
    {
      id: "usage",
      header: "Usage",
      cell: ({ row }) => {
        const discount = row.original;
        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="space-y-1">
                  <div className="flex items-center gap-1">
                    <span className="font-medium">
                      {discount.usageCount !== undefined
                        ? discount.usageCount
                        : "-"}
                    </span>
                    {discount.maxUses ? (
                      <span className="text-muted-foreground text-xs">
                        / {discount.maxUses}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        uses
                      </span>
                    )}
                  </div>
                  {discount.maxUses && discount.usageCount !== undefined ? (
                    <div className="w-full bg-gray-200 rounded-full h-1 dark:bg-gray-700">
                      <div
                        className={cn(
                          "h-1 rounded-full transition-all",
                          discount.usageCount / discount.maxUses >= 1
                            ? "bg-red-500"
                            : discount.usageCount / discount.maxUses >= 0.8
                              ? "bg-amber-500"
                              : "bg-green-500",
                        )}
                        style={{
                          width: `${Math.min(100, (discount.usageCount / discount.maxUses) * 100)}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {discount.maxUses
                    ? `${discount.usageCount || 0} of ${discount.maxUses} uses consumed`
                    : "Times this discount code has been used"}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      },
      enableSorting: false,
      size: 80,
    },
    {
      id: "totalAmount",
      header: "Amount",
      cell: ({ row }) => {
        const discount = row.original;
        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1">
                  <span className="font-medium">
                    {discount.totalDiscountAmount !== undefined
                      ? `${opts.symbol}${discount.totalDiscountAmount.toLocaleString()}`
                      : "-"}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Total discount amount given</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      },
      enableSorting: false,
      size: 100,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <DiscountStatusCell
          discount={row.original}
          showTrashed={opts.showTrashed}
          onToggleStatus={opts.onToggleStatus}
        />
      ),
      enableSorting: false,
      size: 90,
    },
    createActionsColumn<DiscountItem>({
      showTrashed: opts.showTrashed,
      onEdit: (d) => opts.onEdit(d.id),
      onDelete: (d) => opts.onDelete(d.id),
      onRestore: (d) => opts.onRestore(d.id),
      onPermanentDelete: (d) => opts.onPermanentDelete(d.id),
      getExtraActions: (d) =>
        !opts.showTrashed
          ? [
              { label: "Duplicate", icon: Copy, onClick: () => opts.onDuplicate(d.id) },
              {
                label: d.isActive ? "Deactivate" : "Activate",
                icon: d.isActive ? X : Check,
                onClick: () => opts.onToggleStatus(d.id, d.isActive),
              },
            ]
          : undefined,
    }),
  ];
}

export { getTypeLabel };
