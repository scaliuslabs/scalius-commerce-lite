import React from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Search, Trash2, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import type { Category } from "./hooks/useProductList";
import { ALL_CATEGORIES } from "./hooks/useProductList";

interface ProductToolbarProps {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  localSearch: string;
  onLocalSearchChange: (value: string) => void;
  onSearch: (e?: React.SyntheticEvent) => void;
  categories: Category[];
  selectedCategory: string;
  onCategoryChange: (value: string) => void;
  hasActiveFilters: boolean | string;
  onClearFilters: () => void;
  selectedCount: number;
  showTrashed: boolean;
  isActionLoading: boolean;
  onBulkDelete: () => void;
}

export const ProductToolbar = React.memo(function ProductToolbar({
  searchInputRef,
  localSearch,
  onLocalSearchChange,
  onSearch,
  categories,
  selectedCategory,
  onCategoryChange,
  hasActiveFilters,
  onClearFilters,
  selectedCount,
  showTrashed,
  isActionLoading,
  onBulkDelete,
}: ProductToolbarProps) {
  return (
    <div className="p-2 sm:p-3 space-y-2">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
          <div className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50 shrink-0">
            Press{" "}
            <kbd className="px-1.5 py-0.5 bg-background border border-border rounded text-xs font-mono">
              /
            </kbd>{" "}
            to search
          </div>
          <form
            onSubmit={onSearch}
            className="flex-1 sm:flex-initial sm:max-w-xs w-full"
          >
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                type="search"
                placeholder="Search name or SKU..."
                value={localSearch}
                onChange={(e) => onLocalSearchChange(e.target.value)}
                className="pl-7 h-7 w-full text-xs"
              />
            </div>
          </form>
          <Select value={selectedCategory} onValueChange={onCategoryChange}>
            <SelectTrigger className="h-7 w-auto sm:w-[160px] text-xs shrink-0">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-background">
              <SelectItem value={ALL_CATEGORIES}>All Categories</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs text-muted-foreground"
              onClick={onClearFilters}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Clear
            </Button>
          )}
        </div>
        <div
          className={cn(
            "transition-opacity duration-200 flex items-center gap-2",
            selectedCount > 0
              ? "opacity-100"
              : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto",
            selectedCount === 0 && "sm:min-w-[90px]",
          )}
        >
          {selectedCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10"
              onClick={onBulkDelete}
              disabled={isActionLoading}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {showTrashed
                ? `Delete (${selectedCount})`
                : `Trash (${selectedCount})`}
            </Button>
          ) : (
            <div className="h-7" />
          )}
        </div>
      </div>
    </div>
  );
});
