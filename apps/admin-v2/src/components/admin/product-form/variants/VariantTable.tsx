// src/components/admin/ProductForm/variants/VariantTable.tsx

import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VariantDisplayRow } from "./VariantDisplayRow";
import { VariantFormEditor, VariantFormRow } from "./VariantFormRow";
import { VariantBulkEditRow } from "./VariantBulkEditRow";
import {
  normalizeVariantOptionLabels,
  type ProductVariant,
  type VariantBulkEditField,
  type VariantBulkEditValue,
  type VariantFormValues,
  type VariantOptionLabels,
} from "./types";
import { useCurrency } from "@/hooks/use-currency";
import { cn } from "@scalius/shared/utils";
import {
  getDiscountDisplay,
  getStockStatus,
  isInventoryTracked,
} from "./utils/variantHelpers";

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
  draftUpdates?: Record<string, Record<string, unknown>>;
  draftNewIds?: string[];
  onBulkEditChange?: (variantId: string, field: VariantBulkEditField, value: VariantBulkEditValue) => void;
  onAddBulkRow?: () => void;
  onRemoveBulkRow?: (id: string) => void;
  productName?: string;
  addVariantDefaults?: Partial<VariantFormValues>;
  optionLabels?: VariantOptionLabels;
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
  draftNewIds = [],
  onBulkEditChange,
  onAddBulkRow,
  onRemoveBulkRow,
  productName,
  addVariantDefaults,
  optionLabels,
}: VariantTableProps) {
  const { symbol } = useCurrency();
  const normalizedOptionLabels = normalizeVariantOptionLabels(optionLabels);
  const selectableVariants = variants.filter((variant) => !variant.isDefault);
  const selectedSelectableCount = selectableVariants.filter((variant) => selectedVariants.has(variant.id)).length;
  const allSelected = selectableVariants.length > 0 && selectedSelectableCount === selectableVariants.length;
  const someSelected = selectedSelectableCount > 0 && selectedSelectableCount < selectableVariants.length;
  const showMobileCards = !isBulkEditing && !editingVariantId && !isAdding;
  const editingVariant = editingVariantId
    ? variants.find((variant) => variant.id === editingVariantId)
    : undefined;
  const showMobileEditor = !isBulkEditing && (isAdding || Boolean(editingVariant));

  return (
    <div className="space-y-0">
      {showMobileCards && (
        <div className="space-y-2 md:hidden">
          {variants.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground">
              <p className="text-sm">No options yet</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onAddVariant}
                className="mt-3"
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Option
              </Button>
            </div>
          ) : (
            variants.map((variant) => (
              <VariantMobileCard
                key={variant.id}
                variant={variant}
                isSelected={selectedVariants.has(variant.id)}
                isDisabled={isAnyRowEditing}
                onToggleSelection={onToggleSelection}
                onEdit={onEdit}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                symbol={symbol}
                optionLabels={normalizedOptionLabels}
              />
            ))
          )}
        </div>
      )}

      {showMobileEditor && (
        <div className="md:hidden overflow-hidden rounded-lg border shadow-sm">
          <VariantFormEditor
            initialData={editingVariant}
            defaultValues={isAdding ? addVariantDefaults : undefined}
            onSave={onSaveVariant}
            onCancel={onCancelEdit}
            isSubmitting={isSubmitting}
            optionLabels={normalizedOptionLabels}
          />
        </div>
      )}

      <div className={cn(
        "overflow-hidden rounded-lg border",
        showMobileCards && "hidden md:block",
        showMobileEditor && "hidden md:block",
      )}>
        <Table>
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent border-b border-border/60">
              <TableHead className="w-9 py-2 pl-3 pr-1 align-middle">
                <Checkbox
                  checked={allSelected}
                  ref={(el) => {
                    if (el) {
                      (el as unknown as HTMLInputElement).indeterminate = someSelected;
                    }
                  }}
                  onCheckedChange={onToggleAllSelection}
                  disabled={isAnyRowEditing || selectableVariants.length === 0}
                  aria-label="Select all options"
                  className="h-3.5 w-3.5"
                />
              </TableHead>
              {isBulkEditing ? (
                <>
                  <TableHead className="min-w-[110px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">SKU</TableHead>
                  <TableHead className="min-w-[90px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    <span className="block leading-none">
                      {normalizedOptionLabels.option1}
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[90px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    <span className="block leading-none">
                      {normalizedOptionLabels.option2}
                    </span>
                  </TableHead>
                  <TableHead className="min-w-[72px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Weight</TableHead>
                  <TableHead className="min-w-[88px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Price</TableHead>
                  <TableHead className="min-w-[110px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Limit</TableHead>
                  <TableHead className="min-w-[80px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Stock</TableHead>
                  <TableHead className="sticky right-0 z-20 w-[44px] bg-muted/40 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"></TableHead>
                </>
              ) : (
                <>
                  <TableHead className="min-w-[110px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">SKU</TableHead>
                  <TableHead className="min-w-[140px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Options</TableHead>
                  <TableHead className="min-w-[100px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Price</TableHead>
                  <TableHead className="min-w-[130px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Inventory</TableHead>
                  <TableHead className="min-w-[72px] py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Updated</TableHead>
                  <TableHead className="sticky right-0 z-20 w-[64px] bg-muted/40 py-2 pr-3 text-right text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70"></TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.length === 0 && !isAdding && draftNewIds.length === 0 && (
              <TableRow>
                <TableCell colSpan={12} className="h-24 text-center">
                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                    <p className="text-sm">No options yet</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={isBulkEditing ? onAddBulkRow : onAddVariant}
                      className="mt-2"
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      Add Option
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
                    optionLabels={normalizedOptionLabels}
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
                  optionLabels={normalizedOptionLabels}
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
                  productName={productName}
                  optionLabels={normalizedOptionLabels}
                />
              );
            })}

            {isBulkEditing && draftNewIds.map((newId) => {
              const draft = draftUpdates?.[newId] || {};
              const dummyVariant = {
                id: newId,
                sku: draft.sku || '',
                price: draft.price || 0,
                stock: draft.stock || 0,
                trackInventory: draft.trackInventory ?? true,
                size: draft.size || null,
                color: draft.color || null,
                weight: draft.weight || null,
              } as ProductVariant;

              return (
                <VariantBulkEditRow
                  key={newId}
                  variant={dummyVariant}
                  draftUpdate={draftUpdates?.[newId]}
                  onChange={onBulkEditChange!}
                  isNew={true}
                  onRemoveNew={() => onRemoveBulkRow?.(newId)}
                  optionLabels={normalizedOptionLabels}
                />
              );
            })}

            {isAdding && (
              <VariantFormRow
                defaultValues={addVariantDefaults}
                onSave={onSaveVariant}
                onCancel={onCancelEdit}
                isSubmitting={isSubmitting}
                optionLabels={normalizedOptionLabels}
              />
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add option button at the bottom - only show if not adding */}
      {!isAdding && (variants.length > 0 || draftNewIds.length > 0) && (
        <div className="flex justify-start pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={isBulkEditing ? onAddBulkRow : onAddVariant}
            disabled={isAnyRowEditing}
            className="h-8 text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add Option
          </Button>
        </div>
      )}
    </div>
  );
}

function VariantMobileCard({
  variant,
  isSelected,
  isDisabled,
  onToggleSelection,
  onEdit,
  onDelete,
  onDuplicate,
  symbol,
  optionLabels,
}: {
  variant: ProductVariant;
  isSelected: boolean;
  isDisabled: boolean;
  onToggleSelection: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  symbol: string;
  optionLabels?: VariantOptionLabels;
}) {
  const normalizedOptionLabels = normalizeVariantOptionLabels(optionLabels);
  const inventoryTracked = isInventoryTracked(variant);
  const isProtectedDefaultSku = variant.isDefault === true;
  const availableStock = inventoryTracked
    ? Math.max(0, variant.stock - variant.reservedStock)
    : null;
  const stockStatus = availableStock === null ? null : getStockStatus(availableStock);
  const optionBadges = (
    isProtectedDefaultSku
      ? [variant.weight && `${variant.weight}g`]
      : [
          variant.size && `${normalizedOptionLabels.option1}: ${variant.size}`,
          variant.color && `${normalizedOptionLabels.option2}: ${variant.color}`,
          variant.weight && `${variant.weight}g`,
        ]
  ).filter(Boolean);
  const editLabel = isProtectedDefaultSku ? "Edit product SKU" : "Edit option";

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 shadow-sm",
        isSelected && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => {
            if (!isProtectedDefaultSku) onToggleSelection(variant.id);
          }}
          aria-label={`Select option ${variant.sku}`}
          disabled={isDisabled || isProtectedDefaultSku}
          className="mt-1 h-4 w-4"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="break-all font-mono text-sm font-semibold text-foreground">
                {variant.sku}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {isProtectedDefaultSku && (
                  <Badge variant="outline" className="h-5 border-sky-200 bg-sky-50 px-1.5 text-[10px] text-sky-700">
                    Product SKU
                  </Badge>
                )}
                {optionBadges.length > 0 ? (
                  optionBadges.map((label) => (
                    <Badge key={label} variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {label}
                    </Badge>
                  ))
                ) : (
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    No options
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label={editLabel}
                disabled={isDisabled}
                onClick={() => onEdit(variant.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={isDisabled}
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
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">Price</div>
              <div className="mt-1 font-semibold text-foreground" suppressHydrationWarning>
                {symbol}
                {variant.price.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">Available</div>
              {availableStock === null ? (
                <div className="mt-1 font-semibold text-emerald-700">No stock limit</div>
              ) : (
                <div className={cn(
                  "mt-1 font-semibold",
                  availableStock <= 0
                    ? "text-red-600"
                    : availableStock <= 5
                      ? "text-amber-600"
                      : "text-emerald-700",
                )}>
                  {availableStock}
                  {stockStatus === "low" ? " low" : ""}
                  {stockStatus === "out-of-stock" ? " out" : ""}
                </div>
              )}
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">Stock limit</div>
              <div className={cn(
                "mt-1 font-semibold",
                inventoryTracked ? "text-sky-700" : "text-emerald-700",
              )}>
                {inventoryTracked ? "Track stock" : "No stock limit"}
              </div>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">On hand</div>
              <div className="mt-1 font-semibold text-foreground">
                {inventoryTracked ? variant.stock : "No stock limit"}
              </div>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">Discount</div>
              <div className="mt-1 font-semibold text-foreground">
                {getDiscountDisplay(variant, symbol)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
