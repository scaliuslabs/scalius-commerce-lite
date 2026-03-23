import React, { useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Package,
  Plus,
  Loader2,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ProductRow } from "./ProductRow";
import type { ProductListItem, SortField } from "./hooks/useProductList";

interface ProductTableProps {
  products: ProductListItem[];
  selectedProducts: Set<string>;
  selectAllCheckedState: boolean | "indeterminate";
  showTrashed: boolean;
  isLoadingProducts: boolean;
  isActionLoading: boolean;
  hasActiveFilters: boolean | string;
  sort: { field: SortField; order: "asc" | "desc" };
  onSort: (field: SortField) => void;
  onToggleAll: (checked: boolean | "indeterminate") => void;
  onToggleSelection: (id: string, checked: boolean) => void;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  formatDate: (date: Date | null) => string;
  formatPrice: (price: number) => string;
}

export const ProductTable = React.memo(function ProductTable({
  products,
  selectedProducts,
  selectAllCheckedState,
  showTrashed,
  isLoadingProducts,
  isActionLoading,
  hasActiveFilters,
  sort,
  onSort,
  onToggleAll,
  onToggleSelection,
  onView,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  formatDate,
  formatPrice,
}: ProductTableProps) {
  const getSortIcon = useCallback(
    (field: SortField) => {
      if (sort.field !== field) {
        return <ArrowUpDown className="ml-1 h-4 w-4 inline" />;
      }
      return sort.order === "asc" ? (
        <ArrowUp className="ml-1 h-4 w-4 inline" />
      ) : (
        <ArrowDown className="ml-1 h-4 w-4 inline" />
      );
    },
    [sort],
  );

  return (
    <div className="border-t relative">
      {isLoadingProducts && (
        <div className="absolute inset-0 bg-(--background)/80 backdrop-blur-sm z-10 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">
              Loading products...
            </p>
          </div>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-10 pl-3 pr-1 py-2">
              <Checkbox
                checked={selectAllCheckedState}
                onCheckedChange={onToggleAll}
                aria-label="Select all products on this page"
                disabled={products.length === 0}
                className="h-3.5 w-3.5"
              />
            </TableHead>
            <TableHead className="w-[50px] py-2">Image</TableHead>
            <TableHead className="py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("name")}
              >
                Product Info {getSortIcon("name")}
              </Button>
            </TableHead>
            <TableHead className="w-[140px] py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("category")}
              >
                Category {getSortIcon("category")}
              </Button>
            </TableHead>
            <TableHead className="w-[110px] py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("price")}
              >
                Price {getSortIcon("price")}
              </Button>
            </TableHead>
            <TableHead className="w-[80px] py-2 text-xs">Variants</TableHead>
            <TableHead className="w-[120px] py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("updatedAt")}
              >
                Last Updated {getSortIcon("updatedAt")}
              </Button>
            </TableHead>
            <TableHead className="w-[70px] text-right pr-3 py-2 text-xs">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isActionLoading && products.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
                <Loader2 className="h-5 w-5 animate-spin mx-auto" />
              </TableCell>
            </TableRow>
          )}
          {!isActionLoading && products.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
                <div className="flex flex-col items-center justify-center gap-1.5">
                  <Package className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-base font-medium text-muted-foreground">
                    {hasActiveFilters
                      ? "No products match your criteria."
                      : showTrashed
                        ? "Trash is empty."
                        : "No products created yet."}
                  </p>
                  {!showTrashed && !hasActiveFilters && (
                    <Button
                      size="sm"
                      asChild
                      className="mt-1 h-7 text-xs"
                    >
                      <Link to="/admin/products/new">
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Add First Product
                      </Link>
                    </Button>
                  )}
                  {showTrashed && !hasActiveFilters && (
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Products moved to trash will appear here.
                    </p>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                isSelected={selectedProducts.has(product.id)}
                onSelect={onToggleSelection}
                onView={onView}
                onEdit={onEdit}
                onDelete={onDelete}
                onRestore={onRestore}
                onPermanentDelete={onPermanentDelete}
                showTrashed={showTrashed}
                formatDate={formatDate}
                formatPrice={formatPrice}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
});
