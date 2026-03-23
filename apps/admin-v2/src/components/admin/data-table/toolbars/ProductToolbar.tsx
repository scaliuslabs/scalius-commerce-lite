import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Trash2 } from "lucide-react";
import { DataTableToolbar } from "../DataTableToolbar";

const ALL_CATEGORIES = "all";

interface Category {
  id: string;
  name: string;
}

interface ProductToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  categories: Category[];
  selectedCategory: string;
  onCategoryChange: (value: string) => void;
  selectedCount: number;
  showTrashed: boolean;
  onBulkDelete: () => void;
  isBulkDeleting: boolean;
}

export function ProductToolbar({
  searchValue,
  onSearchChange,
  categories,
  selectedCategory,
  onCategoryChange,
  selectedCount,
  showTrashed,
  onBulkDelete,
  isBulkDeleting,
}: ProductToolbarProps) {
  const filters: ReactNode = (
    <Select value={selectedCategory} onValueChange={onCategoryChange}>
      <SelectTrigger className="h-9 w-auto sm:w-[160px] text-xs shrink-0">
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
  );

  const bulkActions: ReactNode =
    selectedCount > 0 ? (
      <Button
        variant="outline"
        size="sm"
        className="h-9 text-xs text-destructive border-destructive hover:bg-destructive/10"
        onClick={onBulkDelete}
        disabled={isBulkDeleting}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" />
        {showTrashed
          ? `Delete (${selectedCount})`
          : `Trash (${selectedCount})`}
      </Button>
    ) : null;

  return (
    <DataTableToolbar
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search name or SKU..."
      selectedCount={selectedCount}
      bulkActions={bulkActions}
      filters={filters}
    />
  );
}
