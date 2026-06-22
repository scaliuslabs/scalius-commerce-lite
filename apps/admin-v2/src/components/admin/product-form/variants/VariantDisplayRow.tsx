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

  return (
    <TableRow
      key={variant.id}
      data-state={isSelected ? "selected" : undefined}
      className={cn(
        "group transition-colors hover:bg-muted/50",
        isSelected && "bg-muted"
      )}
    >
      <TableCell className="w-10 pl-3 pr-1 py-2">
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

      <TableCell className="py-2">
        <div className="font-medium font-mono text-xs text-foreground flex items-center gap-1.5">
          {variant.sku}
          {isSimpleDefaultSku && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 leading-none border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-900/30 dark:text-sky-300">
              Product SKU
            </Badge>
          )}
          {!inventoryTracked && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 leading-none border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300">
              No stock limit
            </Badge>
          )}
          {hasVariantDiscount && (
            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 leading-none bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800">
              SALE
            </Badge>
          )}
        </div>
        {variant.barcode && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[10px] text-muted-foreground font-mono">{variant.barcode}</span>
            {variant.barcodeType && (
              <span className="text-[10px] text-muted-foreground uppercase">({variant.barcodeType})</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Print barcode label"
              onClick={(e) => {
                e.stopPropagation();
                printBarcodeLabel(variant, productName);
              }}
            >
              <Printer className="h-2.5 w-2.5" />
            </Button>
          </div>
        )}
      </TableCell>

      <TableCell className="py-2 text-xs text-muted-foreground">{optionOneLabel}</TableCell>

      <TableCell className="py-2 text-xs text-muted-foreground">{optionTwoLabel}</TableCell>

      <TableCell className="py-2 text-xs text-muted-foreground">{variant.weight ? `${variant.weight}g` : "—"}</TableCell>

      <TableCell className="py-2 text-xs font-medium text-foreground">
        <span suppressHydrationWarning>{symbol}{variant.price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </TableCell>

      {/* On Hand */}
      <TableCell className="py-2">
        {inventoryTracked ? (
          <span className="text-xs font-medium text-foreground">{variant.stock}</span>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">No stock limit</span>
        )}
        {inventoryTracked && variant.reservedStock > 0 && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium ml-1" title={`${variant.reservedStock} reserved by orders`}>
            ({variant.reservedStock} rsv)
          </span>
        )}
      </TableCell>

      {/* Available */}
      <TableCell className="py-2">
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

      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">{getDiscountDisplay(variant, symbol)}</TableCell>

      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
        <span suppressHydrationWarning>{formatDate(variant.updatedAt)}</span>
      </TableCell>

      <TableCell className="pr-3 py-2">
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
