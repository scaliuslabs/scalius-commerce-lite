import React from "react";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { BulkGeneratedVariant } from "../types";

interface VariantPreviewTableProps {
  previewVariants: BulkGeneratedVariant[];
  existingSkus: Set<string>;
  skuConflicts: BulkGeneratedVariant[];
  generateBarcodes: boolean;
  symbol: string;
}

const VariantPreviewRow = React.memo(function VariantPreviewRow({
  variant,
  hasConflict,
  generateBarcodes,
  symbol,
}: {
  variant: BulkGeneratedVariant;
  hasConflict: boolean;
  generateBarcodes: boolean;
  symbol: string;
}) {
  return (
    <TableRow
      className={
        hasConflict
          ? "bg-destructive/10 hover:bg-destructive/15"
          : "hover:bg-muted/30"
      }
    >
      <TableCell className="font-mono text-sm">
        {variant.sku}
        {hasConflict && (
          <Badge
            variant="destructive"
            className="ml-2 text-[10px] px-1.5 py-0"
          >
            Exists
          </Badge>
        )}
      </TableCell>
      {generateBarcodes && (
        <TableCell className="font-mono text-xs text-muted-foreground">
          {variant.barcode || "\u2014"}
        </TableCell>
      )}
      <TableCell className="text-sm">{variant.size || "\u2014"}</TableCell>
      <TableCell className="text-sm">{variant.color || "\u2014"}</TableCell>
      <TableCell className="text-right text-sm font-medium">
        {symbol}
        {variant.price.toLocaleString()}
      </TableCell>
      <TableCell className="text-right text-sm">{variant.stock}</TableCell>
    </TableRow>
  );
});

export const VariantPreviewTable = React.memo(function VariantPreviewTable({
  previewVariants,
  existingSkus,
  skuConflicts,
  generateBarcodes,
  symbol,
}: VariantPreviewTableProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold">
          Preview ({previewVariants.length} option
          {previewVariants.length !== 1 ? "s" : ""})
        </Label>
        {skuConflicts.length > 0 && (
          <Badge variant="destructive" className="text-xs px-2 py-0.5">
            {skuConflicts.length} SKU conflict
            {skuConflicts.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>
      <div className="border rounded-lg shadow-sm overflow-hidden max-h-[500px] overflow-y-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0">
            <TableRow className="hover:bg-muted/50">
              <TableHead className="font-semibold">SKU</TableHead>
              {generateBarcodes && (
                <TableHead className="font-semibold">Barcode</TableHead>
              )}
              <TableHead className="font-semibold">Size</TableHead>
              <TableHead className="font-semibold">Color</TableHead>
              <TableHead className="text-right font-semibold">Price</TableHead>
              <TableHead className="text-right font-semibold">Stock</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {previewVariants.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={generateBarcodes ? 6 : 5}
                  className="h-32 text-center"
                >
                  <div className="text-muted-foreground">
                    <p className="text-sm">
                      Add sizes and/or colors to preview options
                    </p>
                    <p className="text-xs mt-1">
                      All combinations will be shown here
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              previewVariants.map((variant, index) => (
                <VariantPreviewRow
                  key={index}
                  variant={variant}
                  hasConflict={existingSkus.has(variant.sku)}
                  generateBarcodes={generateBarcodes}
                  symbol={symbol}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
});
