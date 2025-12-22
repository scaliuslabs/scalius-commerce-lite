// src/components/admin/ProductForm/variants/VariantActionsToolbar.tsx

import { useState } from "react";
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
import { Search, Plus, Trash2, Filter, X } from "lucide-react";
import { BulkVariantGenerator } from "./BulkVariantGenerator";
import { VariantImportExport } from "./VariantImportExport";
import type {
  ProductVariant,
  BulkGeneratedVariant,
  SortField,
  SortOrder,
} from "./types";

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
        <div className="flex items-center gap-2 flex-1 min-w-[300px]">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search variants (SKU, size, color)..."
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-9"
            />
            {searchTerm && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7"
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
            className="gap-2"
          >
            <Filter className="h-4 w-4" />
            {showFilters ? "Hide" : "Filter"}
          </Button>
        </div>

        {/* Right Side - Actions */}
        <div className="flex items-center gap-2">
          {selectedCount > 0 && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{selectedCount} selected</Badge>
              <Button
                variant="destructive"
                size="sm"
                onClick={onBulkDelete}
                disabled={disabled}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </Button>
            </div>
          )}

          <VariantImportExport
            variants={variants}
            existingSkus={variants.map((v) => v.sku)}
            onImport={onImport}
            disabled={disabled}
          />

          <BulkVariantGenerator
            productSlug={productSlug}
            existingVariants={variants}
            onGenerate={onBulkGenerate}
            disabled={disabled}
          />

          <Button size="sm" onClick={onAddVariant} disabled={disabled}>
            <Plus className="mr-2 h-4 w-4" />
            Add Variant
          </Button>
        </div>
      </div>

      {/* Second Row - Sort and Filters (Collapsible) */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 p-3 bg-muted/50 rounded-md">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              Sort by:
            </span>
            <Select value={sortField} onValueChange={handleSortFieldChange}>
              <SelectTrigger className="w-[140px] h-8">
                <SelectValue placeholder="Sort by..." />
              </SelectTrigger>
              <SelectContent>
                {sortOptions.map((option) => (
                  <SelectItem key={option.field} value={option.field}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sortOrder} onValueChange={handleSortOrderChange}>
              <SelectTrigger className="w-[120px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1" />

          <div className="text-sm text-muted-foreground">
            {variants.length} variant{variants.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}
    </div>
  );
}
