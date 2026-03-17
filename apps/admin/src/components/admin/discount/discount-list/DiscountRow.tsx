import React from "react";
import {
  TableCell,
  TableRow,
} from "../../../ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/dropdown-menu";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { Badge } from "../../../ui/badge";
import {
  Tag,
  Percent,
  Truck,
  MoreHorizontal,
  Trash2,
  Undo,
  Pencil,
  Copy,
  X,
  Check,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { navigateTo } from "@/lib/client/navigate";
import { DiscountStatusBadge } from "./DiscountStatusBadge";
import type { DiscountItem } from "./hooks/useDiscountListFilters";

function buildDiscountSummary(
  discount: DiscountItem,
  getTypeLabel: (type: string) => string,
  getDiscountValueDisplay: (discount: DiscountItem) => string,
  symbol: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Type: ${getTypeLabel(discount.type)}`);
  lines.push(`Value: ${getDiscountValueDisplay(discount)}`);
  if (discount.minPurchaseAmount) {
    lines.push(`Min purchase: ${symbol}${discount.minPurchaseAmount.toLocaleString()}`);
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

interface DiscountRowProps {
  discount: DiscountItem;
  isSelected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onToggleStatus: (id: string, currentStatus: boolean) => void;
  showTrashed: boolean;
  formatDate: (date: string | null) => string;
  getTypeLabel: (type: string) => string;
  getDiscountValueDisplay: (discount: DiscountItem) => string;
  symbol: string;
}

export const DiscountRow = React.memo(function DiscountRow({
  discount,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  onToggleStatus,
  showTrashed,
  formatDate,
  getTypeLabel,
  getDiscountValueDisplay,
  symbol,
}: DiscountRowProps) {
  const summaryLines = buildDiscountSummary(discount, getTypeLabel, getDiscountValueDisplay, symbol);

  return (
    <TableRow
      className={cn(
        "hover:bg-muted/50 transition-colors",
        isSelected && "bg-muted",
      )}
      data-state={isSelected ? "selected" : undefined}
    >
      <TableCell className="pl-4 pr-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelect(discount.id, !!checked)}
          aria-label={`Select ${discount.code}`}
        />
      </TableCell>
      <TableCell className="font-medium">
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
                <p className="font-semibold text-sm mb-1.5">{discount.code}</p>
                {summaryLines.map((line, i) => (
                  <p key={i} className="text-muted-foreground">{line}</p>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </TableCell>
      <TableCell>
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
      </TableCell>
      <TableCell>
        <Badge variant="secondary">{getDiscountValueDisplay(discount)}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {formatDate(discount.startDate)}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {discount.endDate ? formatDate(discount.endDate) : "No end date"}
      </TableCell>
      <TableCell>
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
                        (discount.usageCount / discount.maxUses) >= 1
                          ? "bg-red-500"
                          : (discount.usageCount / discount.maxUses) >= 0.8
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
      </TableCell>
      <TableCell>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <span className="font-medium">
                  {discount.totalDiscountAmount !== undefined
                    ? `${symbol}${discount.totalDiscountAmount.toLocaleString()}`
                    : "-"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Total discount amount given</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </TableCell>
      <TableCell>
        <DiscountStatusBadge
          discount={discount}
          showTrashed={showTrashed}
          onToggleStatus={onToggleStatus}
        />
      </TableCell>
      <TableCell className="text-right pr-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[160px]">
            {showTrashed ? (
              <>
                <DropdownMenuItem onClick={() => onRestore(discount.id)}>
                  <Undo className="mr-2 h-4 w-4" />
                  <span>Restore</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onPermanentDelete(discount.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Delete Permanently</span>
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onEdit(discount.id)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  <span>Edit</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void navigateTo(
                      `/admin/discounts/${discount.id}/edit?duplicate=true`,
                    );
                  }}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  <span>Duplicate</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onToggleStatus(discount.id, discount.isActive)}
                >
                  {discount.isActive ? (
                    <>
                      <X className="mr-2 h-4 w-4" />
                      <span>Deactivate</span>
                    </>
                  ) : (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      <span>Activate</span>
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(discount.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Delete</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});
