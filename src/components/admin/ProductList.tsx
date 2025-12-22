// src/components/admin/ProductList.tsx
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Plus,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Image as ImageIcon,
  Package,
  Trash2,
  Undo,
  Pencil,
  XCircle,
  Eye,
  Loader2,
  Tag,
  ShoppingBag,
  AlertTriangle,
  MoreHorizontal,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  X,
  Copy,
} from "lucide-react";
import type { ProductListItem } from "@/lib/admin";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";

type SortField = "name" | "price" | "category" | "createdAt" | "updatedAt";
type SortOrder = "asc" | "desc";

interface Category {
  id: string;
  name: string;
}

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
  stats?: {
    totalProducts: number;
    activeProducts: number;
    productsWithImages: number;
    categoriesCount: number;
  };
}

const ALL_CATEGORIES = "all";

const StatCard = ({
  title,
  value,
  icon: Icon,
  iconBgColor = "bg-gray-100",
  iconTextColor = "text-gray-600",
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  iconBgColor?: string;
  iconTextColor?: string;
}) => (
  <Card className="shadow-sm hover:shadow-md transition-shadow duration-200">
    <CardContent className="p-2 flex items-center space-x-2">
      <div className={cn("rounded-full p-2", iconBgColor)}>
        <Icon className={cn("h-3.5 w-3.5", iconTextColor)} />
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {title}
        </p>
        <p className="text-base font-bold text-foreground">{value}</p>
      </div>
    </CardContent>
  </Card>
);

const ProductRow = React.memo(
  ({
    product,
    isSelected,
    onSelect,
    onView,
    onEdit,
    onDelete,
    onRestore,
    onPermanentDelete,
    showTrashed,
    formatDate,
    formatPrice,
  }: {
    product: ProductListItem;
    isSelected: boolean;
    onSelect: (id: string, checked: boolean) => void;
    onView: (id: string) => void;
    onEdit: (id: string) => void;
    onDelete: (id: string) => void;
    onRestore: (id: string) => void;
    onPermanentDelete: (id: string) => void;
    showTrashed: boolean;
    formatDate: (date: Date | null) => string;
    formatPrice: (price: number) => string;
  }) => {
    const { toast } = useToast();

    const copyProductShortcode = (productSlug: string) => {
      const shortcode = `[product slug="${productSlug}"]`;
      navigator.clipboard
        .writeText(shortcode)
        .then(() => {
          toast({
            title: "Success",
            description: "Product shortcode copied to clipboard!",
          });
        })
        .catch((err) => {
          toast({
            title: "Error",
            description: "Failed to copy shortcode.",
            variant: "destructive",
          });
          console.error("Failed to copy shortcode: ", err);
        });
    };

    return (
      <TableRow
        className={cn(
          "hover:bg-muted/50 transition-colors",
          isSelected && "bg-muted",
        )}
        data-state={isSelected ? "selected" : undefined}
      >
        <TableCell className="pl-3 pr-1 py-2">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onSelect(product.id, !!checked)}
            aria-label={`Select ${product.name}`}
            className="h-3.5 w-3.5"
          />
        </TableCell>
        <TableCell className="py-2">
          <div className="h-8 w-8 overflow-hidden rounded border bg-muted flex items-center justify-center">
            {product.primaryImage ? (
              <img
                src={getOptimizedImageUrl(product.primaryImage)}
                alt={product.name}
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </TableCell>
        <TableCell className="py-2">
          <div
            className="font-medium text-sm text-foreground hover:underline cursor-pointer"
            onClick={() => onView(product.id)}
          >
            {product.name || "Unnamed Product"}
          </div>
          <div className="text-sm text-muted-foreground">
            SKU: {product.sku || "N/A"}
          </div>
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            {product.isActive ? (
              <Badge
                variant="outline"
                className="text-xs px-1.5 py-0.5 border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900/30 dark:text-green-400"
              >
                Active
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs px-1.5 py-0.5">
                Inactive
              </Badge>
            )}
            {product.freeDelivery && (
              <Badge
                variant="outline"
                className="text-xs px-1.5 py-0.5 border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
              >
                Free Delivery
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground py-2">
          {product.category.name || "Uncategorized"}
        </TableCell>
        <TableCell className="py-2">
          <div className="font-medium text-sm text-foreground">
            {formatPrice(product.price)}
          </div>
          {product.discountPercentage && product.discountPercentage > 0 && (
            <div className="text-xs text-green-600 dark:text-green-500">
              {product.discountPercentage}% off
            </div>
          )}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground py-2">
          {product.variantCount} variant{product.variantCount !== 1 ? "s" : ""}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground py-2">
          {formatDate(product.updatedAt)}
        </TableCell>
        <TableCell className="text-right pr-3 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <MoreHorizontal className="h-3.5 w-3.5" />
                <span className="sr-only">Product Actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[170px]">
              {showTrashed ? (
                <>
                  <DropdownMenuItem onClick={() => onRestore(product.id)}>
                    <Undo className="mr-2 h-4 w-4" />
                    <span>Restore Product</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onPermanentDelete(product.id)}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    <span>Delete Permanently</span>
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => onView(product.id)}>
                    <Eye className="mr-2 h-4 w-4" />
                    <span>View Product</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onEdit(product.id)}>
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    Edit Product
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => copyProductShortcode(product.slug)}
                  >
                    <Copy className="mr-2 h-3.5 w-3.5" />
                    Copy Shortcode
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(product.id)}
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
  },
);
ProductRow.displayName = "ProductRow";

export function ProductList({
  products: initialProducts,
  categories,
  pagination: initialPagination,
  initialSearchQuery = "",
  initialCategoryId = ALL_CATEGORIES,
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
  stats,
}: ProductListProps) {
  const { toast } = useToast();
  const [products, setProducts] = useState(initialProducts || []);
  const [pagination, setPagination] = useState(initialPagination);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [selectedCategory, setSelectedCategory] = useState(initialCategoryId);
  const [sort, setSort] = useState(initialSort);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [productToDelete, setProductToDelete] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);

  useEffect(() => {
    setProducts(initialProducts || []);
  }, [initialProducts]);

  useEffect(() => {
    setPagination(initialPagination);
  }, [initialPagination]);

  useEffect(() => {
    const url = new URL(window.location.href);
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
    setSelectedCategory(url.searchParams.get("category") || initialCategoryId);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as SortOrder,
    });
  }, [
    initialSearchQuery,
    initialCategoryId,
    initialSort.field,
    initialSort.order,
  ]);

  const displayStats = useMemo(() => {
    if (stats) {
      return {
        totalProducts: stats.totalProducts,
        activeProducts: stats.activeProducts,
        productsWithImages: stats.productsWithImages,
        categoriesCount: stats.categoriesCount,
      };
    }
    const active = initialProducts.filter((p) => p.isActive).length;
    const withImages = initialProducts.filter((p) => p.primaryImage).length;
    return {
      totalProducts: initialPagination.total,
      activeProducts: active,
      productsWithImages: withImages,
      categoriesCount: categories.length,
    };
  }, [stats, initialProducts, categories, initialPagination.total]);

  const selectAllCheckedState = useMemo(() => {
    if (products.length === 0) return false;
    if (selectedProducts.size === 0) return false;
    if (selectedProducts.size === products.length) return true;
    return "indeterminate";
  }, [selectedProducts.size, products.length]);

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const url = new URL(window.location.href);
      if (searchQuery.trim()) {
        url.searchParams.set("search", searchQuery.trim());
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.delete("page");
      window.location.href = url.toString();
    },
    [searchQuery],
  );

  const handleCategoryChange = useCallback((value: string) => {
    const url = new URL(window.location.href);
    if (value && value !== ALL_CATEGORIES) {
      url.searchParams.set("category", value);
    } else {
      url.searchParams.delete("category");
    }
    url.searchParams.delete("page");
    window.location.href = url.toString();
  }, []);

  const handleSort = useCallback((field: SortField) => {
    const url = new URL(window.location.href);
    const currentOrder = url.searchParams.get("order");
    const currentSort = url.searchParams.get("sort");
    const newOrder =
      currentSort === field && currentOrder === "asc" ? "desc" : "asc";
    url.searchParams.set("sort", field);
    url.searchParams.set("order", newOrder);
    window.location.href = url.toString();
  }, []);

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      const url = new URL(window.location.href);
      url.searchParams.set("page", newPage.toString());
      window.location.href = url.toString();
    },
    [pagination.totalPages],
  );

  const handleLimitChange = useCallback((newLimit: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("limit", newLimit.toString());
    url.searchParams.delete("page");
    window.location.href = url.toString();
  }, []);

  const handleView = useCallback((id: string) => {
    window.location.href = `/admin/products/${id}`;
  }, []);

  const handleEdit = useCallback((id: string) => {
    window.location.href = `/admin/products/${id}/edit`;
  }, []);

  const triggerDelete = useCallback((id: string) => {
    setProductToDelete(id);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!productToDelete) return;
    setIsActionLoading(true);
    const idToDelete = productToDelete;
    setProductToDelete(null);

    try {
      const response = await fetch(`/api/products/${idToDelete}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to move product to trash");

      toast({ title: "Success", description: "Product moved to trash." });
      setProducts((prev) => prev.filter((p) => p.id !== idToDelete));
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
      }));
      setSelectedProducts((prev) => {
        const newSet = new Set(prev);
        newSet.delete(idToDelete);
        return newSet;
      });
    } catch (error) {
      console.error("Error deleting product:", error);
      toast({
        title: "Error",
        description: "Failed to move product to trash.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [productToDelete, toast]);

  const triggerPermanentDelete = useCallback((id: string) => {
    setProductToDelete(id);
  }, []);

  const handlePermanentDelete = useCallback(async () => {
    if (!productToDelete) return;
    setIsActionLoading(true);
    const idToDelete = productToDelete;
    setProductToDelete(null);

    try {
      const response = await fetch(`/api/products/${idToDelete}/permanent`, {
        method: "DELETE",
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: "Product permanently deleted.",
        });
        setProducts((prev) => prev.filter((p) => p.id !== idToDelete));
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - 1),
        }));
        setSelectedProducts((prev) => {
          const newSet = new Set(prev);
          newSet.delete(idToDelete);
          return newSet;
        });
      } else {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to permanently delete product.",
        );
      }
    } catch (error: any) {
      console.error("Error permanently deleting product:", error);
      toast({
        title: "Deletion Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [productToDelete, toast]);

  const handleRestore = useCallback(
    async (id: string) => {
      setIsActionLoading(true);
      try {
        const response = await fetch(`/api/products/${id}/restore`, {
          method: "POST",
        });
        if (!response.ok) throw new Error("Failed to restore product");

        toast({
          title: "Success",
          description: "Product restored successfully.",
        });
        setProducts((prev) => prev.filter((p) => p.id !== id));
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - 1),
        }));
        setSelectedProducts((prev) => {
          const newSet = new Set(prev);
          newSet.delete(id);
          return newSet;
        });
      } catch (error) {
        console.error("Error restoring product:", error);
        toast({
          title: "Error",
          description: "Failed to restore product.",
          variant: "destructive",
        });
      } finally {
        setIsActionLoading(false);
      }
    },
    [toast],
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedProducts.size > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [selectedProducts]);

  const confirmBulkDelete = useCallback(async () => {
    if (selectedProducts.size === 0) return;
    setIsActionLoading(true);
    const idsToDelete = Array.from(selectedProducts);
    setIsConfirmBulkDeleteOpen(false);

    try {
      const response = await fetch("/api/products/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: idsToDelete,
          permanent: showTrashed,
        }),
      });

      if (response.ok) {
        toast({
          title: "Success",
          description: `${idsToDelete.length} products ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
        });

        setProducts((prev) => prev.filter((p) => !idsToDelete.includes(p.id)));
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - idsToDelete.length),
        }));
        setSelectedProducts(new Set());
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to process bulk delete.");
      }
    } catch (error: any) {
      console.error("Error bulk deleting products:", error);
      toast({
        title: "Bulk Deletion Failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [selectedProducts, showTrashed, toast]);

  const toggleProductSelection = useCallback(
    (productId: string, checked: boolean) => {
      setSelectedProducts((prev) => {
        const newSelection = new Set(prev);
        if (checked) {
          newSelection.add(productId);
        } else {
          newSelection.delete(productId);
        }
        return newSelection;
      });
    },
    [],
  );

  const toggleAllProducts = useCallback(
    (checked: boolean | "indeterminate") => {
      const isChecked = typeof checked === "boolean" ? checked : false;
      if (isChecked) {
        setSelectedProducts(new Set(products.map((p) => p.id)));
      } else {
        setSelectedProducts(new Set());
      }
    },
    [products],
  );

  const formatDate = useCallback((date: Date | null): string => {
    if (!date) return "N/A";
    try {
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        return "Invalid date";
      }
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (error) {
      console.error("Error formatting date:", error);
      return "Invalid date";
    }
  }, []);

  const formatPrice = useCallback((price: number): string => {
    return `৳${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }, []);

  const clearFilters = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    url.searchParams.delete("category");
    url.searchParams.delete("page");
    window.location.href = url.toString();
  }, []);

  const hasActiveFilters = searchQuery || selectedCategory !== ALL_CATEGORIES;

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
    <Card className="border-none shadow-none">
      <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {showTrashed ? "Trash" : "Products"}
            </CardTitle>
            <CardDescription className="mt-0 text-xs text-muted-foreground">
              {showTrashed
                ? "View and manage deleted products."
                : `Manage your product catalog. ${pagination.total} total products.`}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                (window.location.href = showTrashed
                  ? "/admin/products"
                  : "/admin/products?trashed=true")
              }
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              {showTrashed ? (
                <>
                  <Package className="h-3.5 w-3.5 mr-1" /> View Active Products
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> View Trash
                </>
              )}
            </Button>
            {!showTrashed && (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => (window.location.href = "/admin/products/new")}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Product
              </Button>
            )}
          </div>
        </div>

        {stats && !showTrashed && (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <StatCard
              title="Total Products"
              value={displayStats.totalProducts}
              icon={ShoppingBag}
              iconBgColor="bg-blue-100 dark:bg-blue-900/30"
              iconTextColor="text-blue-600 dark:text-blue-400"
            />
            <StatCard
              title="Active Products"
              value={displayStats.activeProducts}
              icon={Eye}
              iconBgColor="bg-green-100 dark:bg-green-900/30"
              iconTextColor="text-green-600 dark:text-green-400"
            />
            <StatCard
              title="With Images"
              value={displayStats.productsWithImages}
              icon={ImageIcon}
              iconBgColor="bg-orange-100 dark:bg-orange-900/30"
              iconTextColor="text-orange-600 dark:text-orange-400"
            />
            <StatCard
              title="Categories"
              value={displayStats.categoriesCount}
              icon={Tag}
              iconBgColor="bg-purple-100 dark:bg-purple-900/30"
              iconTextColor="text-purple-600 dark:text-purple-400"
            />
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        <div className="p-2 sm:p-3 space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
              <form
                onSubmit={handleSearch}
                className="flex-1 sm:flex-initial sm:max-w-xs w-full"
              >
                <div className="relative">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search name or SKU..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-7 h-7 w-full text-xs"
                  />
                </div>
              </form>
              <Select
                value={selectedCategory}
                onValueChange={handleCategoryChange}
              >
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
                  onClick={clearFilters}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Clear
                </Button>
              )}
            </div>
            <div
              className={cn(
                "transition-opacity duration-200 flex items-center gap-2",
                selectedProducts.size > 0
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto",
                selectedProducts.size === 0 && "sm:min-w-[90px]",
              )}
            >
              {selectedProducts.size > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10"
                  onClick={handleBulkDelete}
                  disabled={isActionLoading}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  {showTrashed
                    ? `Delete (${selectedProducts.size})`
                    : `Trash (${selectedProducts.size})`}
                </Button>
              ) : (
                <div className="h-7" />
              )}
            </div>
          </div>
        </div>

        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="w-10 pl-3 pr-1 py-2">
                  <Checkbox
                    checked={selectAllCheckedState}
                    onCheckedChange={toggleAllProducts}
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
                    onClick={() => handleSort("name")}
                  >
                    Product Info {getSortIcon("name")}
                  </Button>
                </TableHead>
                <TableHead className="w-[140px] py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("category")}
                  >
                    Category {getSortIcon("category")}
                  </Button>
                </TableHead>
                <TableHead className="w-[110px] py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("price")}
                  >
                    Price {getSortIcon("price")}
                  </Button>
                </TableHead>
                <TableHead className="w-[80px] py-2 text-xs">
                  Variants
                </TableHead>
                <TableHead className="w-[120px] py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("updatedAt")}
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
                          onClick={() =>
                            (window.location.href = "/admin/products/new")
                          }
                          className="mt-1 h-7 text-xs"
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Add First Product
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
                    onSelect={(id, checked) =>
                      toggleProductSelection(id, checked)
                    }
                    onView={handleView}
                    onEdit={handleEdit}
                    onDelete={triggerDelete}
                    onRestore={handleRestore}
                    onPermanentDelete={triggerPermanentDelete}
                    showTrashed={showTrashed}
                    formatDate={formatDate}
                    formatPrice={formatPrice}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-2 sm:p-3 border-t">
            <div className="text-xs text-muted-foreground hidden sm:block">
              {selectedProducts.size > 0
                ? `${selectedProducts.size} of ${pagination.total} row(s) selected.`
                : `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`}
            </div>
            <div className="flex items-center space-x-2 lg:space-x-3">
              <div className="flex items-center space-x-1.5">
                <p className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                  Rows
                </p>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-1.5 text-xs"
                    >
                      {pagination.limit}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {[10, 20, 50, 100].map((pageSize) => (
                      <DropdownMenuItem
                        key={pageSize}
                        onClick={() => handleLimitChange(pageSize)}
                        className={
                          pagination.limit === pageSize
                            ? "bg-gray-100 font-medium dark:bg-gray-700"
                            : ""
                        }
                      >
                        {pageSize} per page
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex w-[90px] items-center justify-center text-xs font-medium text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages}
              </div>
              <div className="flex items-center space-x-0.5">
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="h-7 w-7 p-0 hidden lg:flex"
                        onClick={() => handlePageChange(1)}
                        disabled={pagination.page === 1 || isActionLoading}
                      >
                        <span className="sr-only">First page</span>
                        <ChevronsLeft className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>First Page</p>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="h-7 w-7 p-0"
                        onClick={() => handlePageChange(pagination.page - 1)}
                        disabled={pagination.page === 1 || isActionLoading}
                      >
                        <span className="sr-only">Previous page</span>
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Previous Page</p>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="h-7 w-7 p-0"
                        onClick={() => handlePageChange(pagination.page + 1)}
                        disabled={
                          pagination.page >= pagination.totalPages ||
                          isActionLoading
                        }
                      >
                        <span className="sr-only">Next page</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Next Page</p>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        className="h-7 w-7 p-0 hidden lg:flex"
                        onClick={() => handlePageChange(pagination.totalPages)}
                        disabled={
                          pagination.page >= pagination.totalPages ||
                          isActionLoading
                        }
                      >
                        <span className="sr-only">Last page</span>
                        <ChevronsRight className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Last Page</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={!!productToDelete && !isConfirmBulkDeleteOpen}
        onOpenChange={(open) => !open && setProductToDelete(null)}
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
                ? `This action cannot be undone. Are you sure you want to permanently delete "${products.find((p) => p.id === productToDelete)?.name ?? "this product"}"?`
                : `Are you sure you want to move "${products.find((p) => p.id === productToDelete)?.name ?? "this product"}" to the trash? It can be restored later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={showTrashed ? handlePermanentDelete : handleDelete}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed ? "Delete Permanently" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isConfirmBulkDeleteOpen}
        onOpenChange={setIsConfirmBulkDeleteOpen}
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
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move Selected to
                  Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to{" "}
              {showTrashed ? "permanently delete" : "move to trash"}{" "}
              {selectedProducts.size} product(s).
              {showTrashed && (
                <span className="font-medium text-destructive block mt-1 text-xs">
                  This action cannot be undone.
                </span>
              )}
              {!showTrashed && (
                <span className="block mt-1 text-xs">
                  They can be restored later from the trash view.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBulkDelete}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed
                ? `Delete ${selectedProducts.size}`
                : `Move ${selectedProducts.size} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
