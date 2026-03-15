// src/components/admin/ProductForm/variants/VariantTable.tsx

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VariantDisplayRow } from "./VariantDisplayRow";
import { VariantFormRow } from "./VariantFormRow";
import { VariantBulkEditRow } from "./VariantBulkEditRow";
import type { ProductVariant, VariantFormValues } from "./types";

interface VariantTableProps {
  variants: ProductVariant[];
  selectedVariants: Set<string>;
  editingVariantId: string | null;
  isAdding: boolean;
  isSubmitting: boolean;
  onToggleSelection: (id: string) => void;
  onToggleAllSelection: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onSaveVariant: (values: VariantFormValues) => Promise<boolean>;
  onCancelEdit: () => void;
  isAnyRowEditing: boolean;
  onAddVariant: () => void;
  isBulkEditing?: boolean;
  draftUpdates?: Record<string, any>;
  onBulkEditChange?: (variantId: string, field: string, value: any) => void;
}

export function VariantTable({
  variants,
  selectedVariants,
  editingVariantId,
  isAdding,
  isSubmitting,
  onToggleSelection,
  onToggleAllSelection,
  onEdit,
  onDelete,
  onDuplicate,
  onSaveVariant,
  onCancelEdit,
  isAnyRowEditing,
  onAddVariant,
  isBulkEditing,
  draftUpdates,
  onBulkEditChange,
}: VariantTableProps) {
  const allSelected = variants.length > 0 && selectedVariants.size === variants.length;
  const someSelected = selectedVariants.size > 0 && selectedVariants.size < variants.length;

  return (
    <div className="space-y-0">
      <div className="rounded-lg border shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-muted/50">
              <TableHead className="w-10 pl-3 pr-1 py-1.5 align-middle">
                <Checkbox
                  checked={allSelected}
                  ref={(el) => {
                    if (el) {
                      (el as any).indeterminate = someSelected;
                    }
                  }}
                  onCheckedChange={onToggleAllSelection}
                  disabled={isAnyRowEditing}
                  aria-label="Select all variants"
                  className="h-3.5 w-3.5"
                />
              </TableHead>
              <TableHead className="min-w-[120px] py-2 text-xs font-medium">SKU</TableHead>
              <TableHead className="min-w-[120px] py-2 text-xs font-medium">Barcode</TableHead>
              <TableHead className="min-w-[70px] py-2 text-xs font-medium">Size</TableHead>
              <TableHead className="min-w-[70px] py-2 text-xs font-medium">Color</TableHead>
              <TableHead className="min-w-[80px] py-2 text-xs font-medium">Weight</TableHead>
              <TableHead className="min-w-[90px] py-2 text-xs font-medium">Price</TableHead>
              <TableHead className="min-w-[80px] py-2 text-xs font-medium" title="Physical items in your warehouse">On Hand</TableHead>
              {!isBulkEditing && <TableHead className="min-w-[80px] py-2 text-xs font-medium" title="Physical items minus items reserved by active orders">Available</TableHead>}
              <TableHead className="min-w-[100px] py-2 text-xs font-medium">Discount</TableHead>
              <TableHead className="min-w-[110px] py-2 text-xs font-medium">Updated</TableHead>
              <TableHead className="w-[80px] py-2 text-xs font-medium text-right pr-3">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.length === 0 && !isAdding && (
              <TableRow>
                <TableCell colSpan={11} className="h-24 text-center">
                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                    <p className="text-sm">No variants yet</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onAddVariant}
                      className="mt-2"
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      Add Variant
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )}

            {variants.map((variant) => {
              if (isBulkEditing) {
                return (
                  <VariantBulkEditRow
                    key={variant.id}
                    variant={variant}
                    draftUpdate={draftUpdates?.[variant.id]}
                    onChange={onBulkEditChange!}
                  />
                );
              }

              return editingVariantId === variant.id ? (
                <VariantFormRow
                  key={variant.id}
                  initialData={variant}
                  onSave={onSaveVariant}
                  onCancel={onCancelEdit}
                  isSubmitting={isSubmitting}
                />
              ) : (
                <VariantDisplayRow
                  key={variant.id}
                  variant={variant}
                  isSelected={selectedVariants.has(variant.id)}
                  onToggleSelection={onToggleSelection}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onDuplicate={onDuplicate}
                  isAnyRowEditing={isAnyRowEditing}
                />
              );
            })}

            {isAdding && (
              <VariantFormRow
                onSave={onSaveVariant}
                onCancel={onCancelEdit}
                isSubmitting={isSubmitting}
              />
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add variant button at the bottom - only show if not adding */}
      {!isAdding && variants.length > 0 && (
        <div className="flex justify-start pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onAddVariant}
            disabled={isAnyRowEditing}
            className="h-8 text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add Variant
          </Button>
        </div>
      )}
    </div>
  );
}
