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
  const hasVariantDiscount = hasDiscount(variant);
  const editLabel = isSimpleDefaultSku ? "Edit product SKU" : "Edit option";
  const cellClass = "py-1.5 px-2 align-middle";

  return (
    <TableRow
      key={variant.id}
      data-state={isSelected ? "selected" : undefined}
      className={cn(
        "group transition-colors hover:bg-muted/30",
        isSelected && "bg-primary/[0.04]"
      )}
    >
      <TableCell className={cn(cellClass, "w-9 pl-3 pr-1")}>
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

      <TableCell className={cn(cellClass, "min-w-[110px]")}>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-foreground">
          <span className="truncate font-medium">{variant.sku}</span>
          {isSimpleDefaultSku && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-[16px] leading-none border-sky-200/80 bg-sky-50/80 text-sky-600 dark:border-sky-900 dark:bg-sky-900/20 dark:text-sky-400 shrink-0">
              Product SKU
            </Badge>
          )}
          {hasVariantDiscount && (
            <Badge variant="secondary" className="text-[9px] px-1 py-0 h-[16px] leading-none bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-800 shrink-0">
              Sale
            </Badge>
          )}
        </div>
      </TableCell>

      {/* Options */}
      <TableCell className={cn(cellClass, "min-w-[140px]")}>
        <div className="flex flex-wrap gap-1">
          {!isSimpleDefaultSku ? (
            <>
              {variant.size && <Badge variant="secondary" className="h-[20px] px-1.5 text-[10px] font-medium bg-secondary/50 rounded-[4px]">{variant.size}</Badge>}
              {variant.color && <Badge variant="secondary" className="h-[20px] px-1.5 text-[10px] font-medium bg-secondary/50 rounded-[4px]">{variant.color}</Badge>}
              {variant.weight && <Badge variant="outline" className="h-[20px] px-1.5 text-[10px] font-medium text-muted-foreground/80 rounded-[4px]">{variant.weight}g</Badge>}
              {!variant.size && !variant.color && !variant.weight && <span className="text-[11px] text-muted-foreground/60">—</span>}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground/50 italic">No option</span>
          )}
        </div>
      </TableCell>

      {/* Price */}
      <TableCell className={cn(cellClass, "min-w-[100px]")}>
        <div className="flex flex-col">
          <span className="text-xs font-semibold tabular-nums text-foreground" suppressHydrationWarning>
            {symbol}{variant.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          {hasVariantDiscount && (
            <span className="text-[10px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
              {getDiscountDisplay(variant, symbol)}
            </span>
          )}
        </div>
      </TableCell>

      {/* Inventory */}
      <TableCell className={cn(cellClass, "min-w-[130px]")}>
        <div className="flex flex-col gap-0.5">
          {inventoryTracked ? (
            <>
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  availableStock! <= 0 ? "bg-destructive" :
                  availableStock! <= 5 ? "bg-amber-500" :
                  "bg-emerald-500"
                )} />
                <span className={cn(
                  "text-xs font-semibold tabular-nums",
                  availableStock! <= 0 ? "text-destructive" :
                  availableStock! <= 5 ? "text-amber-600 dark:text-amber-400" :
                  "text-foreground"
                )}>
                  {availableStock}
                </span>
                <span className="text-[10px] text-muted-foreground/60">avail</span>
              </div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60 ml-3">
                <span className="tabular-nums">{variant.stock} on hand</span>
                {variant.reservedStock > 0 && (
                  <span className="tabular-nums text-amber-600/60 dark:text-amber-400/60">
                    · {variant.reservedStock} rsv
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/20 shrink-0" />
              <span className="text-xs text-muted-foreground/60">No stock limit</span>
            </div>
          )}
        </div>
      </TableCell>

      <TableCell className={cn(cellClass, "whitespace-nowrap text-[11px] text-muted-foreground/60")}>
        <span suppressHydrationWarning>{formatDate(variant.updatedAt)}</span>
      </TableCell>

      <TableCell
        className={cn(
          cellClass,
          "sticky right-0 z-10 w-[64px] bg-card pr-3 group-hover:bg-muted/30 transition-colors",
          isSelected && "bg-primary/[0.04]",
        )}
      >
        <div className="flex items-center justify-end gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                aria-label={editLabel}
                disabled={isAnyRowEditing}
                onClick={() => onEdit(variant.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">{editLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 transition-opacity"
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
