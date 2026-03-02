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
        <div className="flex items-center gap-2 flex-1 min-w-[250px]">
          <div className="relative flex-1 max-w-[280px]">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search variants..."
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
            <Filter className="h-3.5 w-3.5" />
            {showFilters ? "Hide Filter" : "Filter"}
          </Button>
        </div>

        {/* Right Side - Actions */}
        <div className="flex items-center gap-2">
          {selectedCount > 0 && (
            <div className="flex items-center gap-2 mr-1">
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

          <div className="flex items-center gap-2">
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

            <Button size="sm" onClick={onAddVariant} disabled={disabled} className="h-8 text-xs">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Variant
            </Button>
          </div>
        </div>
      </div>

      {/* Second Row - Sort and Filters (Collapsible) */}
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
