import type { ColumnDef } from "../table-config";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  AlertTriangle,
  Copy,
  X,
  Check,
} from "lucide-react";
import { formatPrice } from "@scalius/shared/currency";
import { cn } from "@scalius/shared/utils";
import { formatAdminDate } from "~/lib/admin-time";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import { DiscountStatusBadge } from "../../discount/DiscountStatusBadge";
import {
  getDiscountLifecycle,
  getDiscountOutcome,
  getDiscountReadinessIssues,
  getDiscountRequirement,
} from "../../discount/discount-list-model";

export interface DiscountItem {
  id: string;
  revision: number;
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

interface DiscountColumnOptions {
  showTrashed: boolean;
  symbol: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canToggleStatus: boolean;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onToggleStatus: (id: string, currentStatus: boolean, expectedRevision: number) => void;
}

function DiscountStatusCell({
  discount,
  showTrashed,
  onToggleStatus,
  canToggleStatus,
}: {
  discount: DiscountItem;
  showTrashed: boolean;
  onToggleStatus: (id: string, currentStatus: boolean, expectedRevision: number) => void;
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
      onClick={() => onToggleStatus(discount.id, discount.isActive, discount.revision)}
    >
      {statusBadge}
    </Button>
  );
}

export function getDiscountColumns(
  opts: DiscountColumnOptions,
): ColumnDef<DiscountItem, unknown>[] {
  const columns: ColumnDef<DiscountItem, unknown>[] = [
    createSelectColumn<DiscountItem>({ getLabel: (r) => (r as DiscountItem).code }),
    {
      accessorKey: "code",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Discount" />
      ),
      cell: ({ row }) => {
        const discount = row.original;
        const readinessIssues = getDiscountReadinessIssues(discount);
        return (
          <div className="min-w-0 py-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-sm font-semibold tracking-wide text-foreground">
                {discount.code}
              </span>
              {readinessIssues.length > 0 ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                        aria-label={`${readinessIssues.length} discount rule ${readinessIssues.length === 1 ? "issue" : "issues"}`}
                      >
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        Review
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-sm">
                      <p className="mb-1.5 font-semibold">Rule needs review</p>
                      <ul className="space-y-1 text-xs">
                        {readinessIssues.map((issue) => (
                          <li key={issue.code}>{issue.message}</li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {getDiscountOutcome(discount, opts.symbol)}
            </p>
          </div>
        );
      },
      size: 300,
    },
    {
      id: "eligibility",
      header: "Eligibility",
      cell: ({ row }) => {
        const discount = row.original;
        return (
          <div className="py-0.5 text-xs">
            <p className="font-medium text-foreground">
              {getDiscountRequirement(discount, opts.symbol)}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {discount.limitOnePerCustomer
                ? "One use per customer"
                : "No per-customer limit"}
            </p>
          </div>
        );
      },
      enableSorting: false,
      size: 230,
    },
    {
      accessorKey: "startDate",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Schedule" />
      ),
      cell: ({ row }) => {
        const discount = row.original;
        return (
          <div className="py-0.5 text-xs">
            <p className="font-medium text-foreground">
              {formatAdminDate(discount.startDate) ?? "N/A"}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {discount.endDate
                ? `Ends ${formatAdminDate(discount.endDate) ?? "N/A"}`
                : "No end date"}
            </p>
          </div>
        );
      },
      size: 145,
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
      header: "Savings",
      cell: ({ row }) => {
        const discount = row.original;
        return (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1">
                  <span className="font-medium">
                    {discount.totalDiscountAmount !== undefined
                      ? formatPrice(discount.totalDiscountAmount, {
                          symbol: opts.symbol,
                        })
                      : "-"}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Total savings issued by this code</p>
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
  ];

  const hasRowActions = opts.showTrashed
    ? opts.canRestore || opts.canDelete
    : opts.canEdit || opts.canCreate || opts.canDelete || opts.canToggleStatus;

  if (hasRowActions) {
    columns.push(createActionsColumn<DiscountItem>({
      showTrashed: opts.showTrashed,
      onEdit: opts.canEdit ? (d) => opts.onEdit(d.id) : undefined,
      onDelete: opts.canDelete ? (d) => opts.onDelete(d.id) : undefined,
      onRestore: opts.canRestore ? (d) => opts.onRestore(d.id) : undefined,
      onPermanentDelete: opts.canDelete
        ? (d) => opts.onPermanentDelete(d.id)
        : undefined,
      getExtraActions: (d) =>
        !opts.showTrashed
          ? [
              ...(opts.canCreate
                ? [{ label: "Duplicate", icon: Copy, onClick: () => opts.onDuplicate(d.id) }]
                : []),
              ...(opts.canToggleStatus ? [{
                label: d.isActive ? "Deactivate" : "Activate",
                icon: d.isActive ? X : Check,
                onClick: () => opts.onToggleStatus(d.id, d.isActive, d.revision),
              }] : []),
            ]
          : undefined,
    }));
  }

  return columns;
}
