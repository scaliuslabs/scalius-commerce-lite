import { useState, useMemo, useRef, useEffect } from "react";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import {
  deleteCategory,
  deleteCategoryPermanent,
  restoreCategory,
  bulkDeleteCategories,
  bulkRestoreCategories,
} from "~/lib/api.functions";

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
  deletedAt?: Date | null;
  productCount?: number;
}

type SortField = "name" | "createdAt" | "updatedAt";
type SortOrder = "asc" | "desc";

interface Pagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface Stats {
  totalCategories: number;
  categoriesWithImages: number;
  totalProducts: number;
}

interface UseCategoryListParams {
  initialCategories: Category[];
  initialPagination: Pagination;
  initialSearchQuery: string;
  initialSort: { field: SortField; order: SortOrder };
  showTrashed: boolean;
  stats?: Stats;
}

export type { Category, SortField, SortOrder, Pagination, Stats };

export function useCategoryList({
  initialCategories,
  initialPagination,
  initialSearchQuery,
  initialSort,
  showTrashed,
  stats,
}: UseCategoryListParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState(initialCategories || []);
  const [pagination, setPagination] = useState(initialPagination);
  const [localSearch, setLocalSearch] = useState(initialSearchQuery);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [categoryToDelete, setCategoryToDelete] = useState<string | null>(null);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const [isConfirmBulkRestoreOpen, setIsConfirmBulkRestoreOpen] =
    useState(false);
  const searchTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setCategories(initialCategories || []);
  }, [initialCategories]);

  useEffect(() => {
    setPagination(initialPagination);
  }, [initialPagination]);

  // Keyboard shortcut for search
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
      sort?: SortField;
      order?: SortOrder;
    }) => {
      void navigate({
        to: "/admin/categories",
        search: ((prev: any) => ({
          ...prev,
          page: params.page ?? prev.page,
          limit: params.limit ?? prev.limit,
          search: params.search ?? prev.search,
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
        to: "/admin/categories",
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
    mutationFn: (id: string) => deleteCategory({ data: { id } }),
    onMutate: async (id) => {
      setCategories((prev) => prev.filter((c) => c.id !== id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setSelectedCategories((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to move category to trash."));
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onSuccess: () => {
      toast.success("Category moved to trash.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (id: string) => deleteCategoryPermanent({ data: { id } }),
    onMutate: async (id) => {
      setCategories((prev) => prev.filter((c) => c.id !== id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setSelectedCategories((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to permanently delete category."));
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onSuccess: () => {
      toast.success("Category permanently deleted.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreCategory({ data: { id } }),
    onMutate: async (id) => {
      setCategories((prev) => prev.filter((c) => c.id !== id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      setSelectedCategories((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to restore category."));
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onSuccess: () => {
      toast.success("Category restored successfully.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) =>
      bulkDeleteCategories({ data: { categoryIds: ids, permanent: showTrashed } }),
    onMutate: async (ids) => {
      setCategories((prev) => prev.filter((c) => !ids.includes(c.id)));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - ids.length) }));
      setSelectedCategories(new Set());
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to process bulk delete."));
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onSuccess: (_data, ids) => {
      toast.success(
        `${ids.length} categories ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const bulkRestoreMutation = useMutation({
    mutationFn: (ids: string[]) =>
      bulkRestoreCategories({ data: { categoryIds: ids } }),
    onMutate: async (ids) => {
      setCategories((prev) => prev.filter((c) => !ids.includes(c.id)));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - ids.length) }));
      setSelectedCategories(new Set());
    },
    onError: (_err) => {
      toast.error(getServerFnError(_err, "Failed to restore categories."));
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
    onSuccess: (_data, ids) => {
      toast.success(`Restored ${ids.length} categories successfully`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const isActionLoading =
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    restoreMutation.isPending ||
    bulkDeleteMutation.isPending ||
    bulkRestoreMutation.isPending;

  // Derived state
  const displayStats = useMemo(() => {
    if (stats) {
      return {
        totalCategories: stats.totalCategories,
        categoriesWithImages: stats.categoriesWithImages,
        totalProducts: stats.totalProducts,
      };
    }
    return {
      totalCategories: initialPagination.total,
      categoriesWithImages: initialCategories.filter((cat) => cat.imageUrl)
        .length,
      totalProducts: initialCategories.reduce(
        (sum, cat) => sum + (cat.productCount ?? 0),
        0,
      ),
    };
  }, [stats, initialCategories, initialPagination.total]);

  const selectAllCheckedState = useMemo(() => {
    if (categories.length === 0) return false;
    if (selectedCategories.size === 0) return false;
    if (selectedCategories.size === categories.length) return true;
    return "indeterminate" as const;
  }, [selectedCategories.size, categories.length]);

  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.preventDefault();
    },
    [],
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

  const handleDelete = useCallback(() => {
    if (!categoryToDelete) return;
    const idToDelete = categoryToDelete;
    setCategoryToDelete(null);
    deleteMutation.mutate(idToDelete);
  }, [categoryToDelete, deleteMutation]);

  const handlePermanentDelete = useCallback(() => {
    if (!categoryToDelete) return;
    const idToDelete = categoryToDelete;
    setCategoryToDelete(null);
    permanentDeleteMutation.mutate(idToDelete);
  }, [categoryToDelete, permanentDeleteMutation]);

  const handleRestore = useCallback(
    (id: string) => {
      restoreMutation.mutate(id);
    },
    [restoreMutation],
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedCategories.size > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [selectedCategories]);

  const confirmBulkDelete = useCallback(() => {
    if (selectedCategories.size === 0) return;
    const idsToDelete = Array.from(selectedCategories);
    setIsConfirmBulkDeleteOpen(false);
    bulkDeleteMutation.mutate(idsToDelete);
  }, [selectedCategories, bulkDeleteMutation]);

  const confirmBulkRestore = useCallback(() => {
    if (selectedCategories.size === 0) return;
    const idsToRestore = Array.from(selectedCategories);
    setIsConfirmBulkRestoreOpen(false);
    bulkRestoreMutation.mutate(idsToRestore);
  }, [selectedCategories, bulkRestoreMutation]);

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
    setLocalSearch("");
    navigateWithParams({ page: 1, search: "" });
  }, [navigateWithParams]);

  const toggleTrash = useCallback(() => {
    void navigate({
      to: "/admin/categories",
      search: ((prev: any) => {
        const next = { ...prev };
        if (showTrashed) delete next.trashed;
        else next.trashed = true;
        return next;
      }) as any,
    });
  }, [showTrashed, navigate]);

  // formatDate → shared formatDateShort (date-only format)

  const getPlainDescription = useCallback(
    (html: string | null, maxLength: number = 60): string => {
      if (!html) return "";
      let text = html;
      let prev = "";
      while (prev !== text) {
        prev = text;
        text = text.replace(/<[^>]*>/g, "");
      }
      text = text.replace(/&nbsp;/g, " ").trim();
      if (text.length <= maxLength) return text;
      return text.substring(0, maxLength).trim() + "...";
    },
    [],
  );

  const hasActiveFilters = localSearch.trim().length > 0;

  return {
    // State
    categories,
    pagination,
    localSearch,
    setLocalSearch,
    sort: initialSort,
    selectedCategories,
    categoryToDelete,
    setCategoryToDelete,
    isActionLoading,
    isConfirmBulkDeleteOpen,
    setIsConfirmBulkDeleteOpen,
    isConfirmBulkRestoreOpen,
    setIsConfirmBulkRestoreOpen,
    isLoadingCategories: false,
    searchInputRef,

    // Derived
    displayStats,
    selectAllCheckedState,
    hasActiveFilters,

    // Handlers
    handleSearch,
    handleSort,
    handlePageChange,
    handleLimitChange,
    handleDelete,
    handlePermanentDelete,
    handleRestore,
    handleBulkDelete,
    confirmBulkDelete,
    confirmBulkRestore,
    toggleCategorySelection,
    toggleAllCategories,
    clearFilters,
    toggleTrash,
    formatDate,
    getPlainDescription,
  };
}
