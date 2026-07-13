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
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import { DiscountStatusBadge } from "../../discount/DiscountStatusBadge";
import {
  getDiscountLifecycle,
  getDiscountTypeLabel,
  getDiscountValueLabel,
} from "../../discount/discount-list-model";

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

function buildDiscountSummary(
  discount: DiscountItem,
  symbol: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Type: ${getDiscountTypeLabel(discount.type)}`);
  lines.push(`Value: ${getDiscountValueLabel(discount, symbol)}`);
  if (discount.minPurchaseAmount) {
    lines.push(
      `Min purchase: ${symbol}${discount.minPurchaseAmount.toLocaleString()}`,
    );
  }
  if (discount.minQuantity) {
    lines.push(`Min quantity: ${discount.minQuantity}`);
  }
  if (discount.limitOnePerCustomer) {
    lines.push("Limit: 1 per customer");
  }
  lines.push("Stacking: one code per order");
  return lines;
}

interface DiscountColumnOptions {
  showTrashed: boolean;
  symbol: string;
  canToggleStatus: boolean;
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
  canToggleStatus,
}: {
  discount: DiscountItem;
  showTrashed: boolean;
  onToggleStatus: (id: string, currentStatus: boolean) => void;
  canToggleStatus: boolean;
}) {
  if (showTrashed) {
    return <DiscountStatusBadge status="deleted" />;
  }

  const lifecycle = getDiscountLifecycle(discount);
  const statusBadge = <DiscountStatusBadge status={lifecycle} />;

  if (!canToggleStatus) {
    return statusBadge;
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="p-0 h-auto hover:bg-transparent"
      onClick={() => onToggleStatus(discount.id, discount.isActive)}
    >
      {statusBadge}
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
            {getDiscountTypeLabel(discount.type)}
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
          {getDiscountValueLabel(row.original, opts.symbol)}
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
          canToggleStatus={opts.canToggleStatus}
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
              ...(opts.canToggleStatus ? [{
                label: d.isActive ? "Deactivate" : "Activate",
                icon: d.isActive ? X : Check,
                onClick: () => opts.onToggleStatus(d.id, d.isActive),
              }] : []),
            ]
          : undefined,
    }),
  ];
}

export { getDiscountTypeLabel as getTypeLabel };
