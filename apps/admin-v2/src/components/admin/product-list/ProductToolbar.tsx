import { Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useMessages } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";

/** Sort choices as `field:order`, matching the list search params. */
export const PRODUCT_SORTS = [
  ["updatedAt:desc", "sortUpdated"],
  ["createdAt:desc", "sortNewest"],
  ["createdAt:asc", "sortOldest"],
  ["name:asc", "sortTitleAsc"],
  ["name:desc", "sortTitleDesc"],
  ["price:asc", "sortPriceAsc"],
  ["price:desc", "sortPriceDesc"],
] as const satisfies ReadonlyArray<readonly [string, ProductMessageKey]>;

interface ProductToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  categories: Array<{ id: string; name: string }>;
  selectedCategory: string;
  onCategoryChange: (value: string) => void;
  sortValue: string;
  onSortChange: (value: string) => void;
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
  sortValue,
  onSortChange,
  selectedCount,
  showTrashed,
  onBulkDelete,
  isBulkDeleting,
  canBulkDelete,
  bulkActionsDisabled = false,
}: ProductToolbarProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);

  return (
    <DataTableToolbar
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      searchPlaceholder={t("searchPlaceholder")}
      selectedCount={selectedCount}
      filters={
        <>
          <SearchableSelect
            value={selectedCategory}
            onValueChange={onCategoryChange}
            options={[
              { value: "all", label: t("allCategories") },
              ...categories.map((category) => ({ value: category.id, label: category.name })),
            ]}
            placeholder={t("allCategories")}
            searchPlaceholder={t("searchCategories")}
            emptyMessage={r("noResults")}
            ariaLabel={t("filterCategory")}
            triggerClassName="w-full shrink-0 sm:w-auto sm:min-w-40"
          />
          <Select value={sortValue} onValueChange={onSortChange}>
            <SelectTrigger aria-label={t("sortBy")} className="w-full sm:w-auto sm:min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRODUCT_SORTS.map(([value, key]) => (
                <SelectItem key={value} value={value}>{t(key)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
      bulkActions={
        canBulkDelete && selectedCount > 0 ? (
          <Button
            variant={showTrashed ? "destructive" : "outline"}
            size="sm"
            onClick={onBulkDelete}
            disabled={isBulkDeleting || bulkActionsDisabled}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {showTrashed ? r("deletePermanently") : r("moveToTrash")}
          </Button>
        ) : null
      }
    />
  );
}
