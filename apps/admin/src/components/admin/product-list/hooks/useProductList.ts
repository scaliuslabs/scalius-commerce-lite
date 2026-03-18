import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { navigateTo } from "@/lib/client/navigate";
import { useCurrency } from "@/hooks/use-currency";
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  price: number;
  description: string | null;
  isActive: boolean;
  discountPercentage: number | null;
  discountType: "percentage" | "flat" | null;
  discountAmount: number | null;
  freeDelivery: boolean;
  createdAt: Date;
  updatedAt: Date;
  category: {
    name: string;
  };
  variantCount: number;
  imageCount: number;
  primaryImage: string | null;
  sku?: string;
}

export type SortField =
  | "name"
  | "price"
  | "category"
  | "createdAt"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface Category {
  id: string;
  name: string;
}

export interface Pagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProductStats {
  totalProducts: number;
  activeProducts: number;
  productsWithImages: number;
  categoriesCount: number;
}

interface UseProductListParams {
  initialProducts: ProductListItem[];
  categories: Category[];
  initialPagination: Pagination;
  initialSearchQuery: string;
  initialCategoryId: string;
  initialSort: { field: SortField; order: SortOrder };
  showTrashed: boolean;
  stats?: ProductStats;
}

export const ALL_CATEGORIES = "all";

export function useProductList({
  initialProducts,
  categories,
  initialPagination,
  initialSearchQuery,
  initialCategoryId,
  initialSort,
  showTrashed,
  stats,
}: UseProductListParams) {
  const { symbol } = useCurrency();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [products, setProducts] = useState(initialProducts || []);
  const [pagination, setPagination] = useState(initialPagination);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [localSearch, setLocalSearch] = useState(initialSearchQuery);
  const [selectedCategory, setSelectedCategory] = useState(initialCategoryId);
  const [sort, setSort] = useState(initialSort);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [productToDelete, setProductToDelete] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const searchTimeoutRef = useRef<number | undefined>(undefined);
  const prevSearchQueryRef = useRef(initialSearchQuery);

  useEffect(() => {
    setProducts(initialProducts || []);
  }, [initialProducts]);

  useEffect(() => {
    setPagination(initialPagination);
  }, [initialPagination]);

  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const url = new URL(window.location.href);
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
    setSelectedCategory(
      url.searchParams.get("category") || initialCategoryId,
    );
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

  const fetchProducts = useCallback(
    async (params: {
      page?: number;
      limit?: number;
      search?: string;
      category?: string;
      sort?: SortField;
      order?: SortOrder;
    }) => {
      setIsLoadingProducts(true);
      try {
        const url = new URL("/api/v1/admin/products", window.location.origin);
        if (params.page) url.searchParams.set("page", params.page.toString());
        if (params.limit)
          url.searchParams.set("limit", params.limit.toString());
        if (params.search) url.searchParams.set("search", params.search);
        if (params.category && params.category !== ALL_CATEGORIES)
          url.searchParams.set("category", params.category);
        if (params.sort) url.searchParams.set("sort", params.sort);
        if (params.order) url.searchParams.set("order", params.order);
        if (showTrashed) url.searchParams.set("trashed", "true");

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error("Failed to fetch products");
        const data = unwrapEnvelope(await res.json());

        const parsed = (data.products || []).map(
          (p: Record<string, unknown>) => ({
            ...p,
            createdAt: p.createdAt ? new Date(p.createdAt as string) : null,
            updatedAt: p.updatedAt ? new Date(p.updatedAt as string) : null,
          }),
        );
        setProducts(parsed);
        setPagination(data.pagination || initialPagination);

        const urlToUpdate = new URL(window.location.href);
        if (params.page)
          urlToUpdate.searchParams.set("page", params.page.toString());
        if (params.limit)
          urlToUpdate.searchParams.set("limit", params.limit.toString());
        if (params.search)
          urlToUpdate.searchParams.set("search", params.search);
        else urlToUpdate.searchParams.delete("search");
        if (params.category && params.category !== ALL_CATEGORIES)
          urlToUpdate.searchParams.set("category", params.category);
        else urlToUpdate.searchParams.delete("category");
        if (params.sort) urlToUpdate.searchParams.set("sort", params.sort);
        if (params.order) urlToUpdate.searchParams.set("order", params.order);
        if (showTrashed) urlToUpdate.searchParams.set("trashed", "true");
        else urlToUpdate.searchParams.delete("trashed");
        window.history.pushState({}, "", urlToUpdate.toString());
      } catch (err: unknown) {
        console.error("Error fetching products:", err);
        toast.error("Failed to load products. Please try again.");
      } finally {
        setIsLoadingProducts(false);
      }
    },
    [showTrashed, initialPagination],
  );

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current)
      window.clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = window.setTimeout(() => {
      if (localSearch !== searchQuery) setSearchQuery(localSearch);
    }, 500);
    return () => {
      if (searchTimeoutRef.current)
        window.clearTimeout(searchTimeoutRef.current);
    };
  }, [localSearch, searchQuery]);

  useEffect(() => {
    if (searchQuery !== prevSearchQueryRef.current) {
      prevSearchQueryRef.current = searchQuery;
      fetchProducts({
        page: 1,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        category: selectedCategory,
        sort: sort.field,
        order: sort.order,
      });
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcut
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const t = e.target as HTMLElement;
        if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      }
      if (
        e.key === "Escape" &&
        document.activeElement === searchInputRef.current
      ) {
        setLocalSearch("");
        searchInputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const displayStats = useMemo((): ProductStats => {
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
    return "indeterminate" as const;
  }, [selectedProducts.size, products.length]);

  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.preventDefault();
      setSearchQuery(localSearch);
    },
    [localSearch],
  );

  const handleCategoryChange = useCallback(
    (value: string) => {
      setSelectedCategory(value);
      fetchProducts({
        page: 1,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        category: value,
        sort: sort.field,
        order: sort.order,
      });
    },
    [fetchProducts, pagination.limit, searchQuery, sort.field, sort.order],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      setSort({ field, order: newOrder });
      fetchProducts({
        page: pagination.page,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        category: selectedCategory,
        sort: field,
        order: newOrder,
      });
    },
    [
      fetchProducts,
      pagination.page,
      pagination.limit,
      searchQuery,
      selectedCategory,
      sort.field,
      sort.order,
    ],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      fetchProducts({
        page: newPage,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        category: selectedCategory,
        sort: sort.field,
        order: sort.order,
      });
    },
    [
      fetchProducts,
      pagination.totalPages,
      pagination.limit,
      searchQuery,
      selectedCategory,
      sort.field,
      sort.order,
    ],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      fetchProducts({
        page: 1,
        limit: newLimit,
        search: searchQuery.trim() || undefined,
        category: selectedCategory,
        sort: sort.field,
        order: sort.order,
      });
    },
    [fetchProducts, searchQuery, selectedCategory, sort.field, sort.order],
  );

  const handleView = useCallback((id: string) => {
    void navigateTo(`/admin/products/${id}`);
  }, []);

  const handleEdit = useCallback((id: string) => {
    void navigateTo(`/admin/products/${id}/edit`);
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
      const response = await fetch(
        `/api/v1/admin/products/${idToDelete}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorJson, "Failed to move product to trash"));
      }

      toast.success("Product moved to trash.");
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
    } catch (error: unknown) {
      console.error("Error deleting product:", error);
      toast.error("Failed to move product to trash.");
    } finally {
      setIsActionLoading(false);
    }
  }, [productToDelete]);

  const triggerPermanentDelete = useCallback((id: string) => {
    setProductToDelete(id);
  }, []);

  const handlePermanentDelete = useCallback(async () => {
    if (!productToDelete) return;
    setIsActionLoading(true);
    const idToDelete = productToDelete;
    setProductToDelete(null);

    try {
      const response = await fetch(
        `/api/v1/admin/products/${idToDelete}/permanent`,
        { method: "DELETE" },
      );

      if (response.ok) {
        toast.success("Product permanently deleted.");
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
        const errorData = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorData, "Failed to permanently delete product"));
      }
    } catch (error: unknown) {
      console.error("Error permanently deleting product:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to permanently delete product.",
      );
    } finally {
      setIsActionLoading(false);
    }
  }, [productToDelete]);

  const handleRestore = useCallback(async (id: string) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/products/${id}/restore`,
        { method: "POST" },
      );
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorJson, "Failed to restore product"));
      }

      toast.success("Product restored successfully.");
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
    } catch (error: unknown) {
      console.error("Error restoring product:", error);
      toast.error("Failed to restore product.");
    } finally {
      setIsActionLoading(false);
    }
  }, []);

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
      const response = await fetch("/api/v1/admin/products/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: idsToDelete,
          permanent: showTrashed,
        }),
      });

      if (response.ok) {
        toast.success(
          `${idsToDelete.length} products ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
        );
        setProducts((prev) =>
          prev.filter((p) => !idsToDelete.includes(p.id)),
        );
        setPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - idsToDelete.length),
        }));
        setSelectedProducts(new Set());
      } else {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorData, "Failed to process bulk delete"));
      }
    } catch (error: unknown) {
      console.error("Error bulk deleting products:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to process bulk delete.",
      );
    } finally {
      setIsActionLoading(false);
    }
  }, [selectedProducts, showTrashed]);

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
    } catch (error: unknown) {
      console.error("Error formatting date:", error);
      return "Invalid date";
    }
  }, []);

  const formatPrice = useCallback(
    (price: number): string => {
      return `${symbol}${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    },
    [symbol],
  );

  const clearFilters = useCallback(() => {
    setLocalSearch("");
    setSearchQuery("");
    setSelectedCategory(ALL_CATEGORIES);
    fetchProducts({
      page: 1,
      limit: pagination.limit,
      sort: sort.field,
      order: sort.order,
    });
  }, [fetchProducts, pagination.limit, sort.field, sort.order]);

  const hasActiveFilters =
    localSearch.trim().length > 0 || selectedCategory !== ALL_CATEGORIES;

  return {
    // State
    products,
    pagination,
    localSearch,
    setLocalSearch,
    selectedCategory,
    sort,
    selectedProducts,
    productToDelete,
    setProductToDelete,
    isActionLoading,
    isConfirmBulkDeleteOpen,
    setIsConfirmBulkDeleteOpen,
    isLoadingProducts,
    searchInputRef,

    // Derived
    displayStats,
    selectAllCheckedState,
    hasActiveFilters,

    // Handlers
    handleSearch,
    handleCategoryChange,
    handleSort,
    handlePageChange,
    handleLimitChange,
    handleView,
    handleEdit,
    triggerDelete,
    handleDelete,
    triggerPermanentDelete,
    handlePermanentDelete,
    handleRestore,
    handleBulkDelete,
    confirmBulkDelete,
    toggleProductSelection,
    toggleAllProducts,
    formatDate,
    formatPrice,
    clearFilters,
  };
}
