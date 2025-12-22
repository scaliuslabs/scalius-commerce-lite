// src/components/admin/ProductForm/variants/VariantDisplayRow.tsx

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { Pencil, Trash2, Copy } from "lucide-react";
import type { ProductVariant } from "./types";
import {
  formatDate,
  getDiscountDisplay,
  getStockStatus,
  hasDiscount,
} from "./utils/variantHelpers";

interface VariantDisplayRowProps {
  variant: ProductVariant;
  isSelected: boolean;
  onToggleSelection: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  isAnyRowEditing: boolean;
}

export function VariantDisplayRow({
  variant,
  isSelected,
  onToggleSelection,
  onEdit,
  onDelete,
  onDuplicate,
  isAnyRowEditing,
}: VariantDisplayRowProps) {
  const stockStatus = getStockStatus(variant.stock);
  const hasVariantDiscount = hasDiscount(variant);

  return (
    <TableRow
      key={variant.id}
      data-state={isSelected ? "selected" : undefined}
      className="group hover:bg-muted/30 transition-colors"
    >
      <TableCell className="p-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection(variant.id)}
          aria-label={`Select variant ${variant.sku}`}
          disabled={isAnyRowEditing}
        />
      </TableCell>

      <TableCell className="font-medium font-mono text-sm">
        {variant.sku}
        {hasVariantDiscount && (
          <Badge variant="secondary" className="ml-2 text-[10px] px-1 py-0">
            SALE
          </Badge>
        )}
      </TableCell>

      <TableCell className="text-sm">{variant.size || "—"}</TableCell>

      <TableCell className="text-sm">{variant.color || "—"}</TableCell>

      <TableCell className="text-sm">{variant.weight ? `${variant.weight}g` : "—"}</TableCell>

      <TableCell className="text-sm font-medium">৳{variant.price.toLocaleString()}</TableCell>

      <TableCell>
        <div className="flex items-center gap-2">
          <span className="text-sm">{variant.stock}</span>
          {stockStatus === "out-of-stock" && (
            <Badge variant="destructive" className="text-[10px] px-1 py-0">
              OUT
            </Badge>
          )}
          {stockStatus === "low" && (
            <Badge variant="secondary" className="text-[10px] px-1 py-0 bg-yellow-500/10 text-yellow-700">
              LOW
            </Badge>
          )}
        </div>
      </TableCell>

      <TableCell className="text-sm">{getDiscountDisplay(variant)}</TableCell>

      <TableCell className="text-sm text-muted-foreground">
        {formatDate(variant.updatedAt)}
      </TableCell>

      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onDuplicate(variant.id)}
            disabled={isAnyRowEditing}
            aria-label={`Duplicate variant ${variant.sku}`}
            title="Duplicate"
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onEdit(variant.id)}
            disabled={isAnyRowEditing}
            aria-label={`Edit variant ${variant.sku}`}
            title="Edit"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => onDelete(variant.id)}
            disabled={isAnyRowEditing}
            aria-label={`Delete variant ${variant.sku}`}
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
