// src/components/admin/ProductForm/variants/VariantActionsToolbar.tsx

import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  ArrowUpDown,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { VariantImportExport } from "./VariantImportExport";
import type {
  ProductVariant,
  BulkGeneratedVariant,
  SortField,
  SortOrder,
} from "./types";

const BulkVariantGenerator = lazy(() =>
  import("./bulk-generator").then((module) => ({
    default: module.BulkVariantGenerator,
  })),
);

interface VariantActionsToolbarProps {
  productSlug?: string;
  variants: ProductVariant[];
  selectedCount: number;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  sortField: SortField;
  sortOrder: SortOrder;
  onSortChange: (field: SortField, order: SortOrder) => void;
  onAddVariant: () => void;
  onBulkDelete: () => void;
  onBulkGenerate: (variants: BulkGeneratedVariant[]) => Promise<void>;
  onImport: (variants: BulkGeneratedVariant[]) => Promise<void>;
  isBulkEditing?: boolean;
  onToggleBulkEdit?: () => void;
  onSaveBulkEdit?: () => void;
  disabled?: boolean;
}

export function VariantActionsToolbar({
  productSlug,
  variants,
  selectedCount,
  searchTerm,
  onSearchChange,
  sortField,
  sortOrder,
  onSortChange,
  onAddVariant,
  onBulkDelete,
  onBulkGenerate,
  onImport,
  isBulkEditing,
  onToggleBulkEdit,
  onSaveBulkEdit,
  disabled,
}: VariantActionsToolbarProps) {
  const [showFilters, setShowFilters] = useState(false);

  const sortOptions: Array<{ label: string; field: SortField }> = [
    { label: "SKU", field: "sku" },
    { label: "Price", field: "price" },
    { label: "Stock", field: "stock" },
    { label: "Size", field: "size" },
    { label: "Color", field: "color" },
    { label: "Created Date", field: "createdAt" },
    { label: "Updated Date", field: "updatedAt" },
  ];

  const handleSortFieldChange = (field: string) => {
    onSortChange(field as SortField, sortOrder);
  };

  const handleSortOrderChange = (order: string) => {
    onSortChange(sortField, order as SortOrder);
  };

  return (
    <div className="space-y-3">
      {/* Top Row - Main Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left Side - Search and Filter */}
        <div className="flex w-full items-center gap-2 sm:min-w-[250px] sm:flex-1">
          <div className="relative min-w-0 flex-1 sm:max-w-[280px]">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search options..."
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
            {searchTerm && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-6 w-6"
                onClick={() => onSearchChange("")}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="h-8 text-xs px-2.5 gap-1.5"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {showFilters ? "Hide Sort" : "Sort"}
          </Button>
        </div>

        {/* Right Side - Actions */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {selectedCount > 0 && (
            <div className="flex w-full items-center gap-2 sm:mr-1 sm:w-auto">
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 font-normal">
                {selectedCount} selected
              </Badge>
              <Button
                variant="destructive"
                size="sm"
                onClick={onBulkDelete}
                disabled={disabled}
                className="h-8 text-xs px-2.5"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          )}

          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center">
            {isBulkEditing ? (
              <>
                <Button variant="ghost" size="sm" onClick={onToggleBulkEdit} className="h-8 w-full text-xs sm:w-auto">
                  Cancel
                </Button>
                <Button size="sm" onClick={onSaveBulkEdit} className="h-8 w-full text-xs bg-emerald-600 hover:bg-emerald-700 text-white sm:w-auto">
                  Save Changes
                </Button>
              </>
            ) : (
              <>
                {variants.length > 0 && (
                  <Button variant="outline" size="sm" onClick={onToggleBulkEdit} disabled={disabled} className="h-8 w-full text-xs sm:w-auto">
                    Spreadsheet Edit
                  </Button>
                )}
                <VariantImportExport
                  variants={variants}
                  onImport={onImport}
                  disabled={disabled}
                />

                <LazyBulkVariantGenerator
                  productSlug={productSlug}
                  existingVariants={variants}
                  onGenerate={onBulkGenerate}
                  disabled={disabled}
                />

                <Button size="sm" onClick={onAddVariant} disabled={disabled} className="h-8 w-full text-xs bg-primary text-primary-foreground sm:w-auto">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add Option
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Second Row - Sort controls (Collapsible) */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2.5 p-2 bg-muted/40 rounded-md border text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground whitespace-nowrap font-medium">
              Sort by
            </span>
            <Select value={sortField} onValueChange={handleSortFieldChange}>
              <SelectTrigger className="w-[130px] h-7 text-xs bg-background">
                <SelectValue placeholder="Sort by..." />
              </SelectTrigger>
              <SelectContent className="text-xs">
                {sortOptions.map((option) => (
                  <SelectItem key={option.field} value={option.field}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sortOrder} onValueChange={handleSortOrderChange}>
              <SelectTrigger className="w-[110px] h-7 text-xs bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="text-xs">
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

interface LazyBulkVariantGeneratorProps {
  productSlug?: string;
  existingVariants: ProductVariant[];
  onGenerate: (variants: BulkGeneratedVariant[]) => Promise<void>;
  disabled?: boolean;
}

function LazyBulkVariantGenerator({
  productSlug,
  existingVariants,
  onGenerate,
  disabled,
}: LazyBulkVariantGeneratorProps) {
  const [shouldLoad, setShouldLoad] = useState(false);

  if (!shouldLoad) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setShouldLoad(true)}
        className="h-8 w-full justify-center text-xs sm:w-auto"
      >
        <Sparkles className="mr-2 h-4 w-4" />
        Bulk Generate
      </Button>
    );
  }

  return (
    <Suspense
      fallback={
        <Button variant="outline" size="sm" disabled className="h-8 w-full justify-center text-xs sm:w-auto">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Bulk Generate
        </Button>
      }
    >
      <BulkVariantGenerator
        productSlug={productSlug}
        existingVariants={existingVariants}
        onGenerate={onGenerate}
        disabled={disabled}
        initialOpen
      />
    </Suspense>
  );
}
