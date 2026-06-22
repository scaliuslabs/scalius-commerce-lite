// src/components/admin/ProductForm/variants/VariantDisplayRow.tsx

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { Pencil, Trash2, Copy, MoreHorizontal, Printer } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ProductVariant } from "./types";
import {
  formatDate,
  getDiscountDisplay,
  getStockStatus,
  hasDiscount,
  isInventoryTracked,
} from "./utils/variantHelpers";
import { useCurrency } from "@/hooks/use-currency";
import { cn } from "@scalius/shared/utils";
import { generateBarcodeSvg } from "@scalius/shared/barcode-svg";

interface VariantDisplayRowProps {
  variant: ProductVariant;
  isSelected: boolean;
  onToggleSelection: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  isAnyRowEditing: boolean;
  productName?: string;
}

function printBarcodeLabel(variant: ProductVariant, productName: string) {
  const svg = generateBarcodeSvg(variant.barcode!, {
    moduleWidth: 2,
    height: 80,
    quietZone: 10,
    showText: true,
    fontSize: 16,
  });

  const html = `<!DOCTYPE html>
<html>
<head>
<title>Barcode Label</title>
<style>
  @page { size: 62mm 29mm; margin: 0; }
  body { margin: 0; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: system-ui, sans-serif; }
  .label { text-align: center; padding: 8px; }
  .product-name { font-size: 11px; font-weight: 600; margin-bottom: 2px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sku { font-size: 9px; color: #666; margin-bottom: 4px; font-family: monospace; }
  .barcode svg { max-width: 200px; height: auto; }
</style>
</head>
<body>
<div class="label">
  <div class="product-name">${productName.replace(/</g, "&lt;")}</div>
  <div class="sku">${variant.sku.replace(/</g, "&lt;")}</div>
  <div class="barcode">${svg}</div>
</div>
<script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}</script>
</body>
</html>`;

  const printWindow = window.open("", "_blank", "width=400,height=300");
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
  }
}

export function VariantDisplayRow({
  variant,
  isSelected,
  onToggleSelection,
  onEdit,
  onDelete,
  onDuplicate,
  isAnyRowEditing,
  productName = "",
}: VariantDisplayRowProps) {
  const { symbol } = useCurrency();
  const inventoryTracked = isInventoryTracked(variant);
  const isSimpleDefaultSku = variant.isDefault === true;
  const isProtectedDefaultSku = variant.isDefault === true;
  const availableStock = inventoryTracked
    ? Math.max(0, variant.stock - variant.reservedStock)
    : null;
  const stockStatus = availableStock === null ? null : getStockStatus(availableStock);
  const hasVariantDiscount = hasDiscount(variant);
  const editLabel = isSimpleDefaultSku ? "Edit product SKU" : "Edit option";
  const optionOneLabel = variant.size || (isSimpleDefaultSku ? "No option" : "—");
  const optionTwoLabel = variant.color || (isSimpleDefaultSku ? "No option" : "—");
  const cellClass = "h-10 border-r px-2 py-1.5 align-middle last:border-r-0";

  return (
    <TableRow
      key={variant.id}
      data-state={isSelected ? "selected" : undefined}
      className={cn(
        "group h-10 transition-colors hover:bg-muted/40",
        isSelected && "bg-muted"
      )}
    >
      <TableCell className={cn(cellClass, "w-10 pl-3 pr-1")}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => {
            if (!isProtectedDefaultSku) onToggleSelection(variant.id);
          }}
          aria-label={`Select option ${variant.sku}`}
          disabled={isAnyRowEditing || isProtectedDefaultSku}
          className="h-3.5 w-3.5"
        />
      </TableCell>

      <TableCell className={cn(cellClass, "min-w-[140px]")}>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs font-medium text-foreground">
          <span className="truncate">{variant.sku}</span>
          {isSimpleDefaultSku && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 leading-none border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-900/30 dark:text-sky-300">
              Product SKU
            </Badge>
          )}
          {hasVariantDiscount && (
            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 leading-none bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800">
              SALE
            </Badge>
          )}
        </div>
      </TableCell>

      <TableCell className={cn(cellClass, "text-xs text-muted-foreground")}>{optionOneLabel}</TableCell>

      <TableCell className={cn(cellClass, "text-xs text-muted-foreground")}>{optionTwoLabel}</TableCell>

      <TableCell className={cn(cellClass, "text-xs text-muted-foreground")}>{variant.weight ? `${variant.weight}g` : "—"}</TableCell>

      <TableCell className={cn(cellClass, "text-xs font-medium text-foreground")}>
        <span suppressHydrationWarning>{symbol}{variant.price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </TableCell>

      <TableCell className={cellClass}>
        <Badge
          variant="outline"
          className={cn(
            "h-5 whitespace-nowrap px-1.5 text-[10px] leading-none",
            inventoryTracked
              ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-900/30 dark:text-sky-300"
              : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300",
          )}
        >
          {inventoryTracked ? "Track stock" : "No stock limit"}
        </Badge>
      </TableCell>

      {/* On Hand */}
      <TableCell className={cellClass}>
        {inventoryTracked ? (
          <span className="text-xs font-medium text-foreground">{variant.stock}</span>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">-</span>
        )}
        {inventoryTracked && variant.reservedStock > 0 && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium ml-1" title={`${variant.reservedStock} reserved by orders`}>
            ({variant.reservedStock} rsv)
          </span>
        )}
      </TableCell>

      {/* Available */}
      <TableCell className={cellClass}>
        <div className="flex items-center gap-1">
          {availableStock === null ? (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 leading-none whitespace-nowrap bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900">
              No stock limit
            </Badge>
          ) : (
            <span className={cn(
              "text-xs font-semibold",
              availableStock <= 0 ? "text-red-600 dark:text-red-400" : availableStock <= 5 ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-500"
            )}>{availableStock}</span>
          )}
          {stockStatus === "out-of-stock" && (
            <Badge variant="destructive" className="text-[9px] px-1 py-0 h-4 leading-none whitespace-nowrap bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800">
              OUT
            </Badge>
          )}
          {stockStatus === "low" && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 leading-none whitespace-nowrap bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800">
              LOW
            </Badge>
          )}
        </div>
      </TableCell>

      <TableCell className={cn(cellClass, "whitespace-nowrap text-xs text-muted-foreground")}>{getDiscountDisplay(variant, symbol)}</TableCell>

      <TableCell className={cn(cellClass, "whitespace-nowrap text-xs text-muted-foreground")}>
        <span suppressHydrationWarning>{formatDate(variant.updatedAt)}</span>
      </TableCell>

      <TableCell
        className={cn(
          cellClass,
          "sticky right-0 z-10 w-[72px] bg-card pr-2 shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.35)] group-hover:bg-muted/40",
          isSelected && "bg-muted",
        )}
      >
        <div className="flex items-center justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={editLabel}
                disabled={isAnyRowEditing}
                onClick={() => onEdit(variant.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{editLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                disabled={isAnyRowEditing}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
                <span className="sr-only">Option actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[160px]">
              <DropdownMenuItem onClick={() => onEdit(variant.id)}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                {editLabel}
              </DropdownMenuItem>
              {!isProtectedDefaultSku && (
                <DropdownMenuItem onClick={() => onDuplicate(variant.id)}>
                  <Copy className="mr-2 h-3.5 w-3.5" />
                  Duplicate
                </DropdownMenuItem>
              )}
              {variant.barcode && (
                <DropdownMenuItem onClick={() => printBarcodeLabel(variant, productName)}>
                  <Printer className="mr-2 h-3.5 w-3.5" />
                  Print Label
                </DropdownMenuItem>
              )}
              {!isProtectedDefaultSku && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(variant.id)}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete option
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}
