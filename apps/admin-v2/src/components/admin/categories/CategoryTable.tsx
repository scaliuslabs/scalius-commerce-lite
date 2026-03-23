import React, { useCallback } from "react";
import { Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../../ui/dropdown-menu";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  MoreHorizontal,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Tag,
  Trash2,
  Pencil,
  ShoppingBag,
  Undo,
  XCircle,
  Plus,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { useNavigate } from "@tanstack/react-router";
import type { Category, SortField } from "./hooks/useCategoryList";

interface CategoryRowProps {
  category: Category;
  isSelected: boolean;
  showTrashed: boolean;
  onToggleSelection: (id: string, checked: boolean) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  formatDate: (date: Date) => string;
  getPlainDescription: (html: string | null, maxLength?: number) => string;
  getStorefrontPath: (path: string) => string;
}

const CategoryRow = React.memo(function CategoryRow({
  category,
  isSelected,
  showTrashed,
  onToggleSelection,
  onRestore,
  onDelete,
  formatDate,
  getPlainDescription,
  getStorefrontPath,
}: CategoryRowProps) {
  const navigate = useNavigate();
  return (
    <TableRow
      className={cn(
        "hover:bg-muted/50 transition-colors",
        isSelected && "bg-muted",
      )}
      data-state={isSelected ? "selected" : undefined}
      data-admin-list-row=""
    >
      <TableCell className="pl-3 pr-1 py-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) =>
            onToggleSelection(category.id, !!checked)
          }
          aria-label={`Select ${category.name}`}
          className="h-3.5 w-3.5"
        />
      </TableCell>
      <TableCell className="py-2.5">
        <div className="flex items-center gap-3">
          {category.imageUrl ? (
            <div className="h-11 w-11 rounded-lg overflow-hidden border bg-muted shrink-0">
              <img
                src={getOptimizedImageUrl(category.imageUrl)}
                alt={category.name}
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            </div>
          ) : (
            <div className="h-11 w-11 rounded-lg border bg-muted/50 flex items-center justify-center shrink-0">
              <Tag className="h-5 w-5 text-muted-foreground/50" />
            </div>
          )}
          <div className="flex flex-col min-w-0">
            <Link
              to={`/admin/categories/${category.id}/edit` as string}
              className="font-medium text-sm text-foreground hover:text-primary cursor-pointer truncate"
            >
              {category.name}
            </Link>
            <span className="text-xs text-muted-foreground truncate">
              {category.slug}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="py-2.5 max-w-[200px]">
        {category.description ? (
          <span className="text-sm text-muted-foreground">
            {getPlainDescription(category.description)}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground/50 italic">
            No description
          </span>
        )}
      </TableCell>
      <TableCell className="py-2.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "text-sm tabular-nums",
              (category.productCount ?? 0) > 0
                ? "text-foreground font-medium"
                : "text-muted-foreground/60",
            )}
          >
            {category.productCount ?? 0}
          </span>
          {(category.productCount ?? 0) > 0 && (
            <Link
              to={`/admin/products?category=${category.id}` as string}
              className="text-xs text-primary/80 hover:text-primary hover:underline"
            >
              view
            </Link>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2.5">
        <span className="text-sm text-muted-foreground">
          {formatDate(category.updatedAt)}
        </span>
      </TableCell>
      <TableCell className="text-right pr-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span className="sr-only">Category Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[170px]">
            {showTrashed ? (
              <>
                <DropdownMenuItem onClick={() => onRestore(category.id)}>
                  <Undo className="mr-2 h-4 w-4" />
                  <span>Restore Category</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(category.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  <span>Delete Permanently</span>
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem asChild>
                  <Link
                    to={`/admin/categories/${category.id}/edit` as string}
                    className="flex items-center"
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    <span>Edit Category</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href={getStorefrontPath(
                      `/categories/${category.slug}`,
                    )}
                    target="_blank"
                    className="flex items-center"
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    <span>View on Website</span>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link
                    to={`/admin/products?category=${category.id}` as string}
                    className="flex items-center"
                  >
                    <ShoppingBag className="mr-2 h-4 w-4" />
                    <span>View Products</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(category.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Move to Trash</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});

interface CategoryTableProps {
  categories: Category[];
  selectedCategories: Set<string>;
  selectAllCheckedState: boolean | "indeterminate";
  showTrashed: boolean;
  isLoadingCategories: boolean;
  isActionLoading: boolean;
  hasActiveFilters: boolean;
  sort: { field: SortField; order: "asc" | "desc" };
  onSort: (field: SortField) => void;
  onToggleAll: (checked: boolean | "indeterminate") => void;
  onToggleSelection: (id: string, checked: boolean) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  formatDate: (date: Date) => string;
  getPlainDescription: (html: string | null, maxLength?: number) => string;
  getStorefrontPath: (path: string) => string;
}

export const CategoryTable = React.memo(function CategoryTable({
  categories,
  selectedCategories,
  selectAllCheckedState,
  showTrashed,
  isLoadingCategories,
  isActionLoading,
  hasActiveFilters,
  sort,
  onSort,
  onToggleAll,
  onToggleSelection,
  onRestore,
  onDelete,
  formatDate,
  getPlainDescription,
  getStorefrontPath,
}: CategoryTableProps) {
  const navigate = useNavigate();
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
      {isLoadingCategories && (
        <div className="absolute inset-0 bg-(--background)/80 backdrop-blur-sm z-10 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">
              Loading categories...
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
                aria-label="Select all categories on this page"
                disabled={categories.length === 0}
                className="h-3.5 w-3.5"
              />
            </TableHead>
            <TableHead className="py-2 text-sm font-medium">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-sm font-medium"
                onClick={() => onSort("name")}
              >
                Category Info {getSortIcon("name")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-sm font-medium">
              Description
            </TableHead>
            <TableHead className="py-2 text-sm font-medium">
              Products
            </TableHead>
            <TableHead className="w-[120px] py-2 text-sm font-medium">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-sm font-medium"
                onClick={() => onSort("updatedAt")}
              >
                Last Updated {getSortIcon("updatedAt")}
              </Button>
            </TableHead>
            <TableHead className="w-[70px] text-right pr-3 py-2 text-sm font-medium">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isActionLoading && categories.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="h-32 text-center">
                <Loader2 className="h-5 w-5 animate-spin mx-auto" />
              </TableCell>
            </TableRow>
          )}
          {!isActionLoading && categories.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-32 text-center">
                <div className="flex flex-col items-center justify-center gap-1.5">
                  <Tag className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-base font-medium text-muted-foreground">
                    {hasActiveFilters
                      ? "No categories match your criteria."
                      : showTrashed
                        ? "Trash is empty."
                        : "No categories created yet."}
                  </p>
                  {!showTrashed && !hasActiveFilters && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void navigate({ to: "/admin/categories/new" })
                      }
                      className="mt-1 h-7 text-sm font-medium"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add First Category
                    </Button>
                  )}
                  {showTrashed && !hasActiveFilters && (
                    <p className="text-sm text-muted-foreground/80 mt-0.5">
                      Categories moved to trash will appear here.
                    </p>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            categories.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                isSelected={selectedCategories.has(category.id)}
                showTrashed={showTrashed}
                onToggleSelection={onToggleSelection}
                onRestore={onRestore}
                onDelete={onDelete}
                formatDate={formatDate}
                getPlainDescription={getPlainDescription}
                getStorefrontPath={getStorefrontPath}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
});
