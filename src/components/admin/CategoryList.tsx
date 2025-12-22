import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import {
  MoreHorizontal,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Tag,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Pencil,
  ShoppingBag,
  Undo,
  XCircle,
  Plus,
  Loader2,
  AlertTriangle,
  X,
  ExternalLink,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { Checkbox } from "../ui/checkbox";
import { cn } from "@/lib/utils";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";

interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  createdAt: Date;
  updatedAt: Date;
  productCount: number;
}

type SortField = "name" | "createdAt" | "updatedAt";
type SortOrder = "asc" | "desc";

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

export function CategoryList({
  categories: initialCategories,
  pagination: initialPagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
  stats,
}: CategoryListProps) {
  const { toast } = useToast();
  const { getStorefrontPath } = useStorefrontUrl();
  const [categories, setCategories] = useState(initialCategories || []);
  const [pagination, setPagination] = useState(initialPagination);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [sort, setSort] = useState(initialSort);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [categoryToDelete, setCategoryToDelete] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const [isConfirmBulkRestoreOpen, setIsConfirmBulkRestoreOpen] =
    useState(false);

  // Update state if props change (e.g., after navigation)
  useEffect(() => {
    setCategories(initialCategories || []);
  }, [initialCategories]);

  useEffect(() => {
    setPagination(initialPagination);
  }, [initialPagination]);

  useEffect(() => {
    // Sync state with URL params on mount/hydration
    const url = new URL(window.location.href);
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as SortOrder,
    });
  }, [initialSearchQuery, initialSort.field, initialSort.order]);

  // Derived state & memoized values
  const displayStats = useMemo(() => {
    if (stats) {
      return {
        totalCategories: stats.totalCategories,
        categoriesWithImages: stats.categoriesWithImages,
        totalProducts: stats.totalProducts,
      };
    }
    // Fallback to client-side calculation
    return {
      totalCategories: initialPagination.total,
      categoriesWithImages: initialCategories.filter((cat) => cat.imageUrl)
        .length,
      totalProducts: initialCategories.reduce(
        (sum, cat) => sum + cat.productCount,
        0,
      ),
    };
  }, [stats, initialCategories, initialPagination.total]);

  const selectAllCheckedState = useMemo(() => {
    if (categories.length === 0) return false;
    if (selectedCategories.size === 0) return false;
    if (selectedCategories.size === categories.length) return true;
    return "indeterminate";
  }, [selectedCategories.size, categories.length]);

  // Callbacks
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
    url.searchParams.delete("page"); // Reset to page 1 on limit change
    window.location.href = url.toString();
  }, []);

  const handleDelete = useCallback(async () => {
    if (!categoryToDelete) return;
    setIsActionLoading(true);
    const idToDelete = categoryToDelete;
    setCategoryToDelete(null); // Close dialog optimistically

    try {
      const response = await fetch(`/api/categories/${idToDelete}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
          console.log("Category delete error response:", errorData);
        } catch (parseError) {
          console.error("Failed to parse error response:", parseError);
          errorData = {};
        }

        if (errorData.error && errorData.suggestion) {
          // Show detailed error message with suggestion
          toast({
            title: "Cannot Delete Category",
            description: `${errorData.error} ${errorData.suggestion}`,
            variant: "destructive",
          });
        } else {
          toast({
            title: "Error",
            description: "Failed to move category to trash.",
            variant: "destructive",
          });
        }
        return;
      }

      toast({ title: "Success", description: "Category moved to trash." });
      // Optimistic UI Update
      setCategories((prev) => prev.filter((p) => p.id !== idToDelete));
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
      }));
      setSelectedCategories((prev) => {
        const newSet = new Set(prev);
        newSet.delete(idToDelete);
        return newSet;
      });
    } catch (error) {
      console.error("Error deleting category:", error);
      toast({
        title: "Error",
        description: "Failed to move category to trash.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [categoryToDelete, toast]);

  const handlePermanentDelete = useCallback(async () => {
    if (!categoryToDelete) return;
    setIsActionLoading(true);
    const idToDelete = categoryToDelete;
    setCategoryToDelete(null);

    try {
      const response = await fetch(`/api/categories/${idToDelete}/permanent`, {
        method: "DELETE",
      });

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
          console.log("Permanent delete error response:", errorData);
        } catch (parseError) {
          console.error(
            "Failed to parse permanent delete error response:",
            parseError,
          );
          errorData = {};
        }

        if (errorData.error && errorData.suggestion) {
          // Show detailed error message with suggestion
          toast({
            title: "Cannot Delete Category",
            description: `${errorData.error} ${errorData.suggestion}`,
            variant: "destructive",
          });
        } else {
          toast({
            title: "Error",
            description: "Failed to permanently delete category.",
            variant: "destructive",
          });
        }
        return;
      }

      toast({ title: "Success", description: "Category permanently deleted." });
      // Optimistic UI Update
      setCategories((prev) => prev.filter((p) => p.id !== idToDelete));
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
      }));
      setSelectedCategories((prev) => {
        const newSet = new Set(prev);
        newSet.delete(idToDelete);
        return newSet;
      });
    } catch (error) {
      console.error("Error permanently deleting category:", error);
      toast({
        title: "Error",
        description: "Failed to permanently delete category.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [categoryToDelete, toast]);

  const handleRestore = useCallback(
    async (id: string) => {
      setIsActionLoading(true);
      try {
        const response = await fetch(`/api/categories/${id}/restore`, {
          method: "POST",
        });
        if (!response.ok) throw new Error("Failed to restore category");

        toast({
          title: "Success",
          description: "Category restored successfully.",
        });
        // Optimistic UI Update
        setCategories((prev) => prev.filter((p) => p.id !== id));
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - 1),
        }));
        setSelectedCategories((prev) => {
          const newSet = new Set(prev);
          newSet.delete(id);
          return newSet;
        });
      } catch (error) {
        console.error("Error restoring category:", error);
        toast({
          title: "Error",
          description: "Failed to restore category.",
          variant: "destructive",
        });
      } finally {
        setIsActionLoading(false);
      }
    },
    [toast],
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedCategories.size > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [selectedCategories]);

  const confirmBulkDelete = useCallback(async () => {
    if (selectedCategories.size === 0) return;
    setIsActionLoading(true);
    const idsToDelete = Array.from(selectedCategories);
    setIsConfirmBulkDeleteOpen(false); // Close dialog

    try {
      const response = await fetch("/api/categories/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryIds: idsToDelete,
          permanent: showTrashed,
        }),
      });

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
          console.log("Bulk delete error response:", errorData);
        } catch (parseError) {
          console.error(
            "Failed to parse bulk delete error response:",
            parseError,
          );
          errorData = {};
        }

        if (errorData.error && errorData.suggestion) {
          // Show detailed error message with suggestion and affected products
          const productList = errorData.affectedProducts
            ? errorData.affectedProducts
                .slice(0, 3)
                .map((p: any) => p.name)
                .join(", ")
            : "";

          const fullMessage = productList
            ? `${errorData.error} ${errorData.suggestion} Affected products: ${productList}${errorData.affectedProducts.length > 3 ? "..." : ""}`
            : `${errorData.error} ${errorData.suggestion}`;

          toast({
            title: "Cannot Delete Categories",
            description: fullMessage,
            variant: "destructive",
          });
        } else {
          toast({
            title: "Error",
            description: "Failed to process bulk delete.",
            variant: "destructive",
          });
        }
        return;
      }

      toast({
        title: "Success",
        description: `${idsToDelete.length} categories ${
          showTrashed ? "permanently deleted" : "moved to trash"
        }.`,
      });

      // Optimistic UI Update
      setCategories((prev) => prev.filter((p) => !idsToDelete.includes(p.id)));
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToDelete.length),
      }));
      setSelectedCategories(new Set()); // Clear selection
    } catch (error) {
      console.error("Error bulk deleting categories:", error);
      toast({
        title: "Error",
        description: "Failed to process bulk delete.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [selectedCategories, showTrashed, toast]);

  const confirmBulkRestore = useCallback(async () => {
    if (selectedCategories.size === 0) return;
    setIsActionLoading(true);
    const idsToRestore = Array.from(selectedCategories);
    setIsConfirmBulkRestoreOpen(false);

    try {
      const response = await fetch("/api/categories/bulk-restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryIds: idsToRestore,
        }),
      });
      if (!response.ok) throw new Error("Failed to restore categories");

      toast({
        title: "Success",
        description: `Restored ${idsToRestore.length} categories successfully`,
      });

      // Optimistic UI Update
      setCategories((prev) => prev.filter((p) => !idsToRestore.includes(p.id)));
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToRestore.length),
      }));
      setSelectedCategories(new Set()); // Clear selection
    } catch (error) {
      console.error("Error restoring categories:", error);
      toast({
        title: "Error",
        description: "Failed to restore categories.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  }, [selectedCategories, toast]);

  const toggleCategorySelection = useCallback(
    (categoryId: string, checked: boolean) => {
      setSelectedCategories((prev) => {
        const newSelection = new Set(prev);
        if (checked) {
          newSelection.add(categoryId);
        } else {
          newSelection.delete(categoryId);
        }
        return newSelection;
      });
    },
    [],
  );

  const toggleAllCategories = useCallback(
    (checked: boolean | "indeterminate") => {
      const isChecked = typeof checked === "boolean" ? checked : false;
      if (isChecked) {
        setSelectedCategories(new Set(categories.map((c) => c.id)));
      } else {
        setSelectedCategories(new Set());
      }
    },
    [categories],
  );

  const clearFilters = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    url.searchParams.delete("page");
    window.location.href = url.toString();
  }, []);

  const toggleTrash = useCallback(() => {
    const url = new URL(window.location.href);
    if (showTrashed) {
      url.searchParams.delete("trashed");
    } else {
      url.searchParams.set("trashed", "true");
    }
    window.location.href = url.toString();
  }, [showTrashed]);

  const formatDate = useCallback((date: Date): string => {
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

  const hasActiveFilters = searchQuery.trim().length > 0;

  return (
    <Card className="border-none shadow-none">
      <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {showTrashed ? "Trash" : "Categories"}
            </CardTitle>
            <CardDescription className="mt-0 text-sm text-muted-foreground/80">
              {showTrashed
                ? "View and manage deleted categories."
                : `Manage your product categories. ${pagination.total} total categories.`}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTrash}
              className="h-7 text-sm text-muted-foreground/80 hover:text-foreground font-medium"
            >
              {showTrashed ? (
                <>
                  <Tag className="h-3.5 w-3.5 mr-1" /> View Categories
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
                className="h-7 text-sm font-medium"
                onClick={() => (window.location.href = "/admin/categories/new")}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Category
              </Button>
            )}
          </div>
        </div>

        {/* Stats Row - Only show if we have stats and not in trash view */}
        {stats && !showTrashed && (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <div className="bg-blue-50 dark:bg-blue-900/30 rounded-lg border border-blue-100 dark:border-blue-800 p-2 flex items-center space-x-2">
              <div className="rounded-full bg-blue-100 dark:bg-blue-900 p-2">
                <Tag className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wide">
                  Total Categories
                </p>
                <p className="text-base font-bold text-foreground">
                  {displayStats.totalCategories}
                </p>
              </div>
            </div>

            <div className="bg-purple-50 dark:bg-purple-900/30 rounded-lg border border-purple-100 dark:border-purple-800 p-2 flex items-center space-x-2">
              <div className="rounded-full bg-purple-100 dark:bg-purple-900 p-2">
                <ShoppingBag className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wide">
                  Products
                </p>
                <p className="text-base font-bold text-foreground">
                  {displayStats.totalProducts}
                </p>
              </div>
            </div>

            <div className="bg-orange-50 dark:bg-orange-900/30 rounded-lg border border-orange-100 dark:border-orange-800 p-2 flex items-center space-x-2">
              <div className="rounded-full bg-orange-100 dark:bg-orange-900 p-2">
                <ImageIcon className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wide">
                  With Images
                </p>
                <p className="text-base font-bold text-foreground">
                  {displayStats.categoriesWithImages}
                </p>
              </div>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-0">
        <div className="p-2 sm:p-3 space-y-2">
          {/* Toolbar: Search, Filter, Bulk Actions */}
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
                    placeholder="Search categories..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-7 h-7 w-full text-sm"
                  />
                </div>
              </form>
              {/* Display Active Filters */}
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
            {/* Bulk Actions Area */}
            <div
              className={cn(
                "transition-opacity duration-200 flex items-center gap-2",
                selectedCategories.size > 0
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none h-0 overflow-hidden sm:h-auto sm:opacity-100 sm:pointer-events-auto",
                selectedCategories.size === 0 && "sm:min-w-[90px]", // Reserve space
              )}
            >
              {
                selectedCategories.size > 0 ? (
                  showTrashed ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-sm font-medium"
                        onClick={() => setIsConfirmBulkRestoreOpen(true)}
                        disabled={isActionLoading}
                      >
                        <Undo className="h-3.5 w-3.5 mr-1" />
                        Restore ({selectedCategories.size})
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-sm font-medium text-destructive border-destructive hover:bg-destructive/10"
                        onClick={handleBulkDelete}
                        disabled={isActionLoading}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Delete ({selectedCategories.size})
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-sm font-medium text-destructive border-destructive hover:bg-destructive/10"
                      onClick={handleBulkDelete}
                      disabled={isActionLoading}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Trash ({selectedCategories.size})
                    </Button>
                  )
                ) : (
                  <div className="h-7" />
                ) /* Placeholder */
              }
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="w-10 pl-3 pr-1 py-2">
                  <Checkbox
                    checked={selectAllCheckedState}
                    onCheckedChange={toggleAllCategories}
                    aria-label="Select all categories on this page"
                    disabled={categories.length === 0}
                    className="h-3.5 w-3.5"
                  />
                </TableHead>
                <TableHead className="py-2 text-sm font-medium">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-sm font-medium"
                    onClick={() => handleSort("name")}
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
                    onClick={() => handleSort("updatedAt")}
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
                            (window.location.href = "/admin/categories/new")
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
                  <TableRow
                    key={category.id}
                    className={cn(
                      "hover:bg-muted/50 transition-colors",
                      selectedCategories.has(category.id) && "bg-muted",
                    )}
                    data-state={
                      selectedCategories.has(category.id)
                        ? "selected"
                        : undefined
                    }
                  >
                    <TableCell className="pl-3 pr-1 py-2">
                      <Checkbox
                        checked={selectedCategories.has(category.id)}
                        onCheckedChange={(checked) =>
                          toggleCategorySelection(category.id, !!checked)
                        }
                        aria-label={`Select ${category.name}`}
                        className="h-3.5 w-3.5"
                      />
                    </TableCell>
                    <TableCell className="flex items-center space-x-2 py-2">
                      {category.imageUrl ? (
                        <div className="h-8 w-8 rounded-md overflow-hidden border bg-muted shrink-0">
                          <img
                            src={getOptimizedImageUrl(category.imageUrl)}
                            alt={category.name}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            decoding="async"
                          />
                        </div>
                      ) : (
                        <div className="h-8 w-8 rounded-md border bg-muted flex items-center justify-center shrink-0">
                          <ImageIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex flex-col">
                        <div
                          className="font-medium text-sm text-foreground hover:underline cursor-pointer"
                          onClick={() =>
                            (window.location.href = `/admin/categories/${category.id}/edit`)
                          }
                        >
                          {category.name}
                        </div>
                        <div className="text-xs text-muted-foreground/70 font-mono">
                          /{category.slug}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-sm">
                      {category.description ? (
                        <span className="line-clamp-1 text-foreground/80">
                          {category.description}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/70 italic text-sm">
                          No description
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-sm">
                      <div className="flex items-center">
                        <span
                          className={`${category.productCount > 0 ? "text-foreground font-semibold" : "text-muted-foreground/70"}`}
                        >
                          {category.productCount}
                        </span>
                        {category.productCount > 0 && (
                          <a
                            href={`/admin/products?category=${category.id}`}
                            className="ml-2 text-xs text-primary hover:underline font-medium"
                          >
                            View
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground/80 py-2 font-medium">
                      {formatDate(category.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right pr-3 py-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                            <span className="sr-only">Category Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[170px]">
                          {showTrashed ? (
                            <>
                              <DropdownMenuItem
                                onClick={() => handleRestore(category.id)}
                              >
                                <Undo className="mr-2 h-4 w-4" />
                                <span>Restore Category</span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setCategoryToDelete(category.id)}
                                className="text-destructive focus:text-destructive focus:bg-destructive/10"
                              >
                                <XCircle className="mr-2 h-4 w-4" />
                                <span>Delete Permanently</span>
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem asChild>
                                <a
                                  href={`/admin/categories/${category.id}/edit`}
                                  className="flex items-center"
                                >
                                  <Pencil className="mr-2 h-4 w-4" />
                                  <span>Edit Category</span>
                                </a>
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
                                <a
                                  href={`/admin/products?category=${category.id}`}
                                  className="flex items-center"
                                >
                                  <ShoppingBag className="mr-2 h-4 w-4" />
                                  <span>View Products</span>
                                </a>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setCategoryToDelete(category.id)}
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
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-2 sm:p-3 border-t">
            <div className="text-sm text-muted-foreground/80 hidden sm:block">
              {selectedCategories.size > 0
                ? `${selectedCategories.size} of ${pagination.total} row(s) selected.`
                : `Showing ${(pagination.page - 1) * pagination.limit + 1}-${Math.min(pagination.page * pagination.limit, pagination.total)} of ${pagination.total}`}
            </div>
            <div className="flex items-center space-x-2 lg:space-x-3">
              <div className="flex items-center space-x-1.5">
                <p className="text-sm font-medium text-muted-foreground/80 whitespace-nowrap">
                  Rows
                </p>
                <Select
                  value={pagination.limit.toString()}
                  onValueChange={(value) => handleLimitChange(Number(value))}
                >
                  <SelectTrigger className="h-7 w-[60px] text-sm">
                    <SelectValue placeholder={pagination.limit} />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl bg-background">
                    {[10, 20, 50, 100].map((pageSize) => (
                      <SelectItem key={pageSize} value={pageSize.toString()}>
                        {pageSize}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-[90px] items-center justify-center text-sm font-medium text-muted-foreground/80">
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

      {/* --- Confirmation Dialogs --- */}
      <AlertDialog
        open={!!categoryToDelete}
        onOpenChange={(open) => !open && setCategoryToDelete(null)}
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
                ? `This action cannot be undone. Are you sure you want to permanently delete "${categories.find((c) => c.id === categoryToDelete)?.name ?? "this category"}"?`
                : `Are you sure you want to move "${categories.find((c) => c.id === categoryToDelete)?.name ?? "this category"}" to the trash? It can be restored later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-sm font-medium"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={showTrashed ? handlePermanentDelete : handleDelete}
              className={cn(
                "h-8 text-sm font-medium",
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
              {selectedCategories.size} category(s).
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
                ? `Delete ${selectedCategories.size}`
                : `Move ${selectedCategories.size} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isConfirmBulkRestoreOpen}
        onOpenChange={setIsConfirmBulkRestoreOpen}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Undo className="h-4 w-4 text-green-500" /> Restore Selected
              Categories?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to restore {selectedCategories.size} category(s).
              They will be visible again in your store.
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
              onClick={confirmBulkRestore}
              className="h-8 text-xs"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              Restore {selectedCategories.size} Categories
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
