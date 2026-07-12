import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
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
  canBulkDelete: boolean;
  bulkActionsDisabled?: boolean;
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
  canBulkDelete,
  bulkActionsDisabled = false,
}: ProductToolbarProps) {
  const filters: ReactNode = (
    <SearchableSelect
      value={selectedCategory}
      onValueChange={onCategoryChange}
      options={[
        { value: ALL_CATEGORIES, label: "All categories" },
        ...categories.map((category) => ({
          value: category.id,
          label: category.name,
        })),
      ]}
      placeholder="All categories"
      searchPlaceholder="Search categories..."
      emptyMessage="No categories found."
      ariaLabel="Filter products by category"
      triggerClassName="w-full shrink-0 sm:w-[190px]"
    />
  );

  const bulkActions: ReactNode =
    canBulkDelete && selectedCount > 0 ? (
      <Button
        variant="outline"
        size="sm"
        className="h-9 text-xs text-destructive border-destructive hover:bg-destructive/10"
        onClick={onBulkDelete}
        disabled={isBulkDeleting || bulkActionsDisabled}
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
