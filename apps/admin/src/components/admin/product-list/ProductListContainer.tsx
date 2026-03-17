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
import { Trash2, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { ProductHeader } from "./ProductHeader";
import { ProductToolbar } from "./ProductToolbar";
import { ProductTable } from "./ProductTable";
import { ProductPagination } from "./ProductPagination";
import { useProductList, ALL_CATEGORIES } from "./hooks/useProductList";
import type {
  ProductListItem,
  Category,
  SortField,
  SortOrder,
  ProductStats,
} from "./hooks/useProductList";

interface ProductListProps {
  products: ProductListItem[];
  categories: Category[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  initialSearchQuery?: string;
  initialCategoryId?: string;
  initialSort?: {
    field: SortField;
    order: SortOrder;
  };
  showTrashed?: boolean;
  stats?: ProductStats;
}

const DEFAULT_SORT: { field: SortField; order: SortOrder } = {
  field: "updatedAt",
  order: "desc",
};

export function ProductList({
  products: initialProducts,
  categories,
  pagination: initialPagination,
  initialSearchQuery = "",
  initialCategoryId = ALL_CATEGORIES,
  initialSort = DEFAULT_SORT,
  showTrashed = false,
  stats,
}: ProductListProps) {
  const hook = useProductList({
    initialProducts,
    categories,
    initialPagination,
    initialSearchQuery,
    initialCategoryId,
    initialSort,
    showTrashed,
    stats,
  });

  return (
    <Card className="border-none shadow-none">
      <ProductHeader
        showTrashed={showTrashed}
        total={hook.pagination.total}
        stats={stats}
        displayStats={hook.displayStats}
      />

      <CardContent className="p-0">
        <ProductToolbar
          searchInputRef={hook.searchInputRef}
          localSearch={hook.localSearch}
          onLocalSearchChange={hook.setLocalSearch}
          onSearch={hook.handleSearch}
          categories={categories}
          selectedCategory={hook.selectedCategory}
          onCategoryChange={hook.handleCategoryChange}
          hasActiveFilters={hook.hasActiveFilters}
          onClearFilters={hook.clearFilters}
          selectedCount={hook.selectedProducts.size}
          showTrashed={showTrashed}
          isActionLoading={hook.isActionLoading}
          onBulkDelete={hook.handleBulkDelete}
        />

        <ProductTable
          products={hook.products}
          selectedProducts={hook.selectedProducts}
          selectAllCheckedState={hook.selectAllCheckedState}
          showTrashed={showTrashed}
          isLoadingProducts={hook.isLoadingProducts}
          isActionLoading={hook.isActionLoading}
          hasActiveFilters={hook.hasActiveFilters}
          sort={hook.sort}
          onSort={hook.handleSort}
          onToggleAll={hook.toggleAllProducts}
          onToggleSelection={hook.toggleProductSelection}
          onView={hook.handleView}
          onEdit={hook.handleEdit}
          onDelete={hook.triggerDelete}
          onRestore={hook.handleRestore}
          onPermanentDelete={hook.triggerPermanentDelete}
          formatDate={hook.formatDate}
          formatPrice={hook.formatPrice}
        />

        <ProductPagination
          pagination={hook.pagination}
          selectedCount={hook.selectedProducts.size}
          isActionLoading={hook.isActionLoading}
          onPageChange={hook.handlePageChange}
          onLimitChange={hook.handleLimitChange}
        />
      </CardContent>

      {/* Single delete confirmation */}
      <AlertDialog
        open={!!hook.productToDelete && !hook.isConfirmBulkDeleteOpen}
        onOpenChange={(open) => !open && hook.setProductToDelete(null)}
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
            <AlertDialogDescription className="pt-1 text-xs">
              {showTrashed
                ? `This action cannot be undone. Are you sure you want to permanently delete "${hook.products.find((p) => p.id === hook.productToDelete)?.name ?? "this product"}"?`
                : `Are you sure you want to move "${hook.products.find((p) => p.id === hook.productToDelete)?.name ?? "this product"}" to the trash? It can be restored later.`}
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
              onClick={
                showTrashed ? hook.handlePermanentDelete : hook.handleDelete
              }
              className={cn(
                "h-8 text-xs",
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
              {hook.selectedProducts.size} product(s).
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
                ? `Delete ${hook.selectedProducts.size}`
                : `Move ${hook.selectedProducts.size} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
