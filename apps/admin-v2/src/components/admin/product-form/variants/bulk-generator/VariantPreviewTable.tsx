import React from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@scalius/shared/utils";
import {
  normalizeVariantOptionLabels,
  type BulkGeneratedVariant,
  type VariantOptionLabels,
} from "../types";
import { getBulkVariantDraftKey } from "../utils/variantHelpers";

type EditableVariantFields = Pick<BulkGeneratedVariant, "sku" | "price" | "stock">;

interface VariantPreviewTableProps {
  previewVariants: BulkGeneratedVariant[];
  conflictsByDraftKey: ReadonlyMap<string, string[]>;
  excludedDraftKeys: ReadonlySet<string>;
  generateBarcodes: boolean;
  symbol: string;
  optionLabels?: VariantOptionLabels;
  hasRowEdits: boolean;
  onVariantChange: (
    draftKey: string,
    changes: Partial<EditableVariantFields>,
  ) => void;
  onIncludedChange: (draftKey: string, included: boolean) => void;
  onResetEdits: () => void;
}

const VariantPreviewRow = React.memo(function VariantPreviewRow({
  variant,
  conflicts,
  excluded,
  generateBarcodes,
  symbol,
  onVariantChange,
  onIncludedChange,
}: {
  variant: BulkGeneratedVariant;
  conflicts: string[];
  excluded: boolean;
  generateBarcodes: boolean;
  symbol: string;
  onVariantChange: VariantPreviewTableProps["onVariantChange"];
  onIncludedChange: VariantPreviewTableProps["onIncludedChange"];
}) {
  const draftKey = getBulkVariantDraftKey(variant.size, variant.color);
  const optionSummary = [variant.size, variant.color].filter(Boolean).join(" / ");
  const hasConflict = !excluded && conflicts.length > 0;

  return (
    <TableRow
      className={cn(
        hasConflict && "bg-destructive/5 hover:bg-destructive/10",
        excluded && "opacity-50",
      )}
    >
      <TableCell className="w-12 text-center">
        <Checkbox
          checked={!excluded}
          onCheckedChange={(checked) => onIncludedChange(draftKey, checked === true)}
          aria-label={`${excluded ? "Include" : "Exclude"} ${optionSummary || "option"}`}
        />
      </TableCell>
      <TableCell className="min-w-[190px]">
        <Input
          value={variant.sku}
          onChange={(event) => onVariantChange(draftKey, { sku: event.target.value })}
          className="h-8 font-mono text-xs"
          aria-label={`SKU for ${optionSummary || "option"}`}
          aria-invalid={hasConflict || undefined}
          disabled={excluded}
        />
        {hasConflict ? (
          <div className="mt-1 flex flex-wrap gap-1" role="alert">
            {conflicts.map((conflict) => (
              <Badge key={conflict} variant="destructive" className="h-4 px-1 text-[9px]">
                {conflict}
              </Badge>
            ))}
          </div>
        ) : null}
      </TableCell>
      {generateBarcodes ? (
        <TableCell className="font-mono text-[11px] text-muted-foreground">
          {variant.barcode || "—"}
        </TableCell>
      ) : null}
      <TableCell className="text-xs">{variant.size || "—"}</TableCell>
      <TableCell className="text-xs">{variant.color || "—"}</TableCell>
      <TableCell className="min-w-[130px]">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {symbol}
          </span>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={variant.price}
            onChange={(event) =>
              onVariantChange(draftKey, { price: Number(event.target.value || 0) })
            }
            className="h-8 pl-7 text-right text-xs"
            aria-label={`Price for ${optionSummary || "option"}`}
            disabled={excluded}
          />
        </div>
      </TableCell>
      <TableCell className="min-w-[110px]">
        {variant.trackInventory === false ? (
          <Badge variant="outline" className="whitespace-nowrap border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
            No stock limit
          </Badge>
        ) : (
          <Input
            type="number"
            min="0"
            step="1"
            value={variant.stock}
            onChange={(event) =>
              onVariantChange(draftKey, { stock: Number(event.target.value || 0) })
            }
            className="h-8 text-right text-xs"
            aria-label={`Stock for ${optionSummary || "option"}`}
            disabled={excluded}
          />
        )}
      </TableCell>
    </TableRow>
  );
});

export const VariantPreviewTable = React.memo(function VariantPreviewTable({
  previewVariants,
  conflictsByDraftKey,
  excludedDraftKeys,
  generateBarcodes,
  symbol,
  optionLabels,
  hasRowEdits,
  onVariantChange,
  onIncludedChange,
  onResetEdits,
}: VariantPreviewTableProps) {
  const normalizedOptionLabels = normalizeVariantOptionLabels(optionLabels);
  const includedCount = previewVariants.reduce(
    (count, variant) =>
      count + (excludedDraftKeys.has(getBulkVariantDraftKey(variant.size, variant.color)) ? 0 : 1),
    0,
  );
  const conflictCount = Array.from(conflictsByDraftKey.entries()).reduce(
    (count, [draftKey, conflicts]) =>
      count + (!excludedDraftKeys.has(draftKey) && conflicts.length > 0 ? 1 : 0),
    0,
  );

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="text-sm font-semibold">Review</Label>
          <p className="text-[11px] text-muted-foreground">
            {includedCount} of {previewVariants.length} options selected
          </p>
        </div>
        <div className="flex items-center gap-2">
          {conflictCount > 0 ? (
            <Badge variant="destructive" className="text-[10px]">
              {conflictCount} blocked
            </Badge>
          ) : null}
          {hasRowEdits ? (
            <Button type="button" variant="ghost" size="sm" onClick={onResetEdits} className="h-7 px-2 text-[11px]">
              <RotateCcw className="mr-1 h-3 w-3" />
              Reset row edits
            </Button>
          ) : null}
        </div>
      </div>

      <div className="max-h-[480px] overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur-sm">
            <TableRow>
              <TableHead className="w-12 text-center">Create</TableHead>
              <TableHead>SKU</TableHead>
              {generateBarcodes ? <TableHead>Barcode</TableHead> : null}
              <TableHead>{normalizedOptionLabels.option1}</TableHead>
              <TableHead>{normalizedOptionLabels.option2}</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Stock</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {previewVariants.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={generateBarcodes ? 7 : 6}
                  className="h-36 text-center text-sm text-muted-foreground"
                >
                  Add values to preview every combination.
                </TableCell>
              </TableRow>
            ) : (
              previewVariants.map((variant) => {
                const draftKey = getBulkVariantDraftKey(variant.size, variant.color);
                return (
                  <VariantPreviewRow
                    key={draftKey}
                    variant={variant}
                    conflicts={conflictsByDraftKey.get(draftKey) ?? []}
                    excluded={excludedDraftKeys.has(draftKey)}
                    generateBarcodes={generateBarcodes}
                    symbol={symbol}
                    onVariantChange={onVariantChange}
                    onIncludedChange={onIncludedChange}
                  />
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
});
