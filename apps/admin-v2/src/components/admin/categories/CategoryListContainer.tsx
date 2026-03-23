import { ErrorBoundary } from "../ErrorBoundary";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Card, CardContent } from "../../ui/card";
import { Trash2, Undo, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { CategoryHeader } from "./CategoryHeader";
import { CategoryToolbar } from "./CategoryToolbar";
import { CategoryTable } from "./CategoryTable";
import { CategoryPagination } from "./CategoryPagination";
import { useCategoryList } from "./hooks/useCategoryList";
import type { Category, SortField, SortOrder } from "./hooks/useCategoryList";

interface CategoryListProps {
  categories: Category[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  initialSearchQuery?: string;
  initialSort?: {
    field: SortField;
    order: SortOrder;
  };
  showTrashed?: boolean;
  stats?: {
    totalCategories: number;
    categoriesWithImages: number;
    totalProducts: number;
  };
}

const DEFAULT_SORT: { field: SortField; order: SortOrder } = {
  field: "updatedAt",
  order: "desc",
};

export function CategoryList({
  categories: initialCategories,
  pagination: initialPagination,
  initialSearchQuery = "",
  initialSort = DEFAULT_SORT,
  showTrashed = false,
  stats,
}: CategoryListProps) {
  const { getStorefrontPath } = useStorefrontUrl();

  const hook = useCategoryList({
    initialCategories,
    initialPagination,
    initialSearchQuery,
    initialSort,
    showTrashed,
    stats,
  });

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading categories. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <Card className="border-none shadow-none">
      <CategoryHeader
        showTrashed={showTrashed}
        total={hook.pagination.total}
        stats={stats}
        displayStats={hook.displayStats}
        onToggleTrash={hook.toggleTrash}
      />

      <CardContent className="p-0">
        <CategoryToolbar
          searchInputRef={hook.searchInputRef}
          localSearch={hook.localSearch}
          onLocalSearchChange={hook.setLocalSearch}
          onSearch={hook.handleSearch}
          hasActiveFilters={hook.hasActiveFilters}
          onClearFilters={hook.clearFilters}
          selectedCount={hook.selectedCategories.size}
          showTrashed={showTrashed}
          isActionLoading={hook.isActionLoading}
          onBulkDelete={hook.handleBulkDelete}
          onBulkRestore={() => hook.setIsConfirmBulkRestoreOpen(true)}
        />

        <CategoryTable
          categories={hook.categories}
          selectedCategories={hook.selectedCategories}
          selectAllCheckedState={hook.selectAllCheckedState}
          showTrashed={showTrashed}
          isLoadingCategories={hook.isLoadingCategories}
          isActionLoading={hook.isActionLoading}
          hasActiveFilters={hook.hasActiveFilters}
          sort={hook.sort}
          onSort={hook.handleSort}
          onToggleAll={hook.toggleAllCategories}
          onToggleSelection={hook.toggleCategorySelection}
          onRestore={hook.handleRestore}
          onDelete={hook.setCategoryToDelete}
          formatDate={hook.formatDate}
          getPlainDescription={hook.getPlainDescription}
          getStorefrontPath={getStorefrontPath}
        />

        <CategoryPagination
          pagination={hook.pagination}
          selectedCount={hook.selectedCategories.size}
          isActionLoading={hook.isActionLoading}
          onPageChange={hook.handlePageChange}
          onLimitChange={hook.handleLimitChange}
        />
      </CardContent>

      {/* Single delete confirmation */}
      <AlertDialog
        open={!!hook.categoryToDelete}
        onOpenChange={(open) => !open && hook.setCategoryToDelete(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-sm text-muted-foreground/90">
              {showTrashed
                ? `This action cannot be undone. Are you sure you want to permanently delete "${hook.categories.find((c) => c.id === hook.categoryToDelete)?.name ?? "this category"}"?`
                : `Are you sure you want to move "${hook.categories.find((c) => c.id === hook.categoryToDelete)?.name ?? "this category"}" to the trash? It can be restored later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={hook.isActionLoading}
              className="h-8 text-sm font-medium"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={
                showTrashed ? hook.handlePermanentDelete : hook.handleDelete
              }
              className={cn(
                "h-8 text-sm font-medium",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={hook.isActionLoading}
            >
              {hook.isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed ? "Delete Permanently" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirmation */}
      <AlertDialog
        open={hook.isConfirmBulkDeleteOpen}
        onOpenChange={hook.setIsConfirmBulkDeleteOpen}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Selected Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move Selected
                  to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to{" "}
              {showTrashed ? "permanently delete" : "move to trash"}{" "}
              {hook.selectedCategories.size} category(s).
              {showTrashed ? (
                <span className="font-medium text-destructive block mt-1 text-xs">
                  This action cannot be undone.
                </span>
              ) : (
                <span className="block mt-1 text-xs">
                  They can be restored later from the trash view.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={hook.isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={hook.confirmBulkDelete}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={hook.isActionLoading}
            >
              {hook.isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed
                ? `Delete ${hook.selectedCategories.size}`
                : `Move ${hook.selectedCategories.size} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk restore confirmation */}
      <AlertDialog
        open={hook.isConfirmBulkRestoreOpen}
        onOpenChange={hook.setIsConfirmBulkRestoreOpen}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Undo className="h-4 w-4 text-green-500" /> Restore Selected
              Categories?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to restore {hook.selectedCategories.size}{" "}
              category(s). They will be visible again in your store.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={hook.isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={hook.confirmBulkRestore}
              className="h-8 text-xs"
              disabled={hook.isActionLoading}
            >
              {hook.isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Restore {hook.selectedCategories.size} Categories
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
    </ErrorBoundary>
  );
}
