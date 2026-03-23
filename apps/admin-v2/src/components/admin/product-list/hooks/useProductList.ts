import { useState, useMemo, useRef, useEffect } from "react";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCurrency } from "@/hooks/use-currency";
import {
  deleteProduct,
  permanentDeleteProduct,
  restoreProduct,
  bulkDeleteProducts,
} from "~/lib/api.functions";
import { getServerFnError } from "@/lib/api-helpers";

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [products, setProducts] = useState(initialProducts || []);
  const [pagination, setPagination] = useState(initialPagination);
  const [localSearch, setLocalSearch] = useState(initialSearchQuery);
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [productToDelete, setProductToDelete] = useState<string | null>(null);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const searchTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setProducts(initialProducts || []);
  }, [initialProducts]);

  useEffect(() => {
    setPagination(initialPagination);
  }, [initialPagination]);

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

  // Navigate via URL search params (TanStack Router re-runs loader automatically)
  const navigateWithParams = useCallback(
    (params: {
      page?: number;
      limit?: number;
      search?: string;
      category?: string;
      sort?: SortField;
      order?: SortOrder;
    }) => {
      void navigate({
        to: "/admin/products",
        search: ((prev: any) => ({
          ...prev,
          page: params.page ?? prev.page,
          limit: params.limit ?? prev.limit,
          search: params.search ?? prev.search,
          category: params.category ?? prev.category,
          sort: params.sort ?? prev.sort,
          order: params.order ?? prev.order,
          trashed: showTrashed,
        })) as any,
      });
    },
    [navigate, showTrashed],
  );

  // Debounced search — navigates via URL
  useEffect(() => {
    if (searchTimeoutRef.current)
      window.clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = window.setTimeout(() => {
      void navigate({
        to: "/admin/products",
        search: ((prev: any) => ({
          ...prev,
          search: localSearch,
          page: 1,
        })) as any,
      });
    }, 500);
    return () => {
      if (searchTimeoutRef.current)
        window.clearTimeout(searchTimeoutRef.current);
    };
  }, [localSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ─────────────────────────────────────────────────────

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProduct({ data: { id } }),
    onMutate: async (id) => {
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setSelectedProducts((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to move product to trash."));
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onSuccess: () => {
      toast.success("Product moved to trash.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (id: string) => permanentDeleteProduct({ data: { id } }),
    onMutate: async (id) => {
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setSelectedProducts((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to permanently delete product."));
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onSuccess: () => {
      toast.success("Product permanently deleted.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreProduct({ data: { id } }),
    onMutate: async (id) => {
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setSelectedProducts((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to restore product."));
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onSuccess: () => {
      toast.success("Product restored successfully.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      bulkDeleteProducts({ data: { productIds: ids, permanent: showTrashed } }),
    onMutate: async (ids) => {
      setProducts((prev) => prev.filter((p) => !ids.includes(p.id)));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - ids.length) }));
      setSelectedProducts(new Set());
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to process bulk delete."));
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onSuccess: (_data, ids) => {
      toast.success(
        `${ids.length} products ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const isActionLoading =
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    restoreMutation.isPending ||
    bulkDeleteMutation.isPending;

  // ── Derived state ─────────────────────────────────────────────────

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

  // ── Handlers ──────────────────────────────────────────────────────

  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.preventDefault();
    },
    [],
  );

  const handleCategoryChange = useCallback(
    (value: string) => {
      navigateWithParams({ page: 1, category: value });
    },
    [navigateWithParams],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      navigateWithParams({
        sort: field,
        order: initialSort.field === field && initialSort.order === "asc" ? "desc" : "asc",
      });
    },
    [navigateWithParams, initialSort.field, initialSort.order],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      navigateWithParams({ page: newPage });
    },
    [navigateWithParams, pagination.totalPages],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      navigateWithParams({ page: 1, limit: newLimit });
    },
    [navigateWithParams],
  );

  const handleView = useCallback(
    (id: string) => {
      void navigate({ to: "/admin/products/$productId", params: { productId: id } });
    },
    [navigate],
  );

  const handleEdit = useCallback(
    (id: string) => {
      void navigate({ to: "/admin/products/$productId/edit", params: { productId: id } });
    },
    [navigate],
  );

  const triggerDelete = useCallback((id: string) => {
    setProductToDelete(id);
  }, []);

  const handleDelete = useCallback(() => {
    if (!productToDelete) return;
    const idToDelete = productToDelete;
    setProductToDelete(null);
    deleteMutation.mutate(idToDelete);
  }, [productToDelete, deleteMutation]);

  const triggerPermanentDelete = useCallback((id: string) => {
    setProductToDelete(id);
  }, []);

  const handlePermanentDelete = useCallback(() => {
    if (!productToDelete) return;
    const idToDelete = productToDelete;
    setProductToDelete(null);
    permanentDeleteMutation.mutate(idToDelete);
  }, [productToDelete, permanentDeleteMutation]);

  const handleRestore = useCallback(
    (id: string) => {
      restoreMutation.mutate(id);
    },
    [restoreMutation],
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedProducts.size > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [selectedProducts]);

  const confirmBulkDelete = useCallback(() => {
    if (selectedProducts.size === 0) return;
    const idsToDelete = Array.from(selectedProducts);
    setIsConfirmBulkDeleteOpen(false);
    bulkDeleteMutation.mutate(idsToDelete);
  }, [selectedProducts, bulkDeleteMutation]);

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

  // formatDate → shared formatDateShort (date-only format)

  const formatPrice = useCallback(
    (price: number): string => {
      return `${symbol}${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    },
    [symbol],
  );

  const clearFilters = useCallback(() => {
    setLocalSearch("");
    navigateWithParams({ page: 1, search: "", category: ALL_CATEGORIES });
  }, [navigateWithParams]);

  const hasActiveFilters =
    localSearch.trim().length > 0 || initialCategoryId !== ALL_CATEGORIES;

  return {
    // State
    products,
    pagination,
    localSearch,
    setLocalSearch,
    selectedCategory: initialCategoryId,
    sort: initialSort,
    selectedProducts,
    productToDelete,
    setProductToDelete,
    isActionLoading,
    isConfirmBulkDeleteOpen,
    setIsConfirmBulkDeleteOpen,
    isLoadingProducts: false,
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
