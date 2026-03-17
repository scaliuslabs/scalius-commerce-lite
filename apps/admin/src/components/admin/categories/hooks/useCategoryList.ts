import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { navigateTo } from "@/lib/client/navigate";

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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState(initialCategories || []);
  const [pagination, setPagination] = useState(initialPagination);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [localSearch, setLocalSearch] = useState(initialSearchQuery);
  const [sort, setSort] = useState(initialSort);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [categoryToDelete, setCategoryToDelete] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);
  const [isConfirmBulkRestoreOpen, setIsConfirmBulkRestoreOpen] =
    useState(false);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const searchTimeoutRef = useRef<number | undefined>(undefined);
  const prevSearchQueryRef = useRef(initialSearchQuery);

  useEffect(() => {
    setCategories(initialCategories || []);
  }, [initialCategories]);

  useEffect(() => {
    setPagination(initialPagination);
  }, [initialPagination]);

  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const url = new URL(window.location.href);
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as SortOrder,
    });
  }, [initialSearchQuery, initialSort.field, initialSort.order]);

  const fetchCategories = useCallback(
    async (params: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: SortField;
      order?: SortOrder;
    }) => {
      setIsLoadingCategories(true);
      try {
        const url = new URL("/api/v1/admin/categories", window.location.origin);
        if (params.page) url.searchParams.set("page", params.page.toString());
        if (params.limit)
          url.searchParams.set("limit", params.limit.toString());
        if (params.search) url.searchParams.set("search", params.search);
        if (params.sort) url.searchParams.set("sort", params.sort);
        if (params.order) url.searchParams.set("order", params.order);
        if (showTrashed) url.searchParams.set("trashed", "true");

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error("Failed to fetch categories");
        const data = await res.json();

        const parsed = (data.categories || []).map(
          (c: Record<string, unknown>) => ({
            ...c,
            createdAt: c.createdAt ? new Date(c.createdAt as string) : null,
            updatedAt: c.updatedAt ? new Date(c.updatedAt as string) : null,
            deletedAt: c.deletedAt ? new Date(c.deletedAt as string) : null,
          }),
        );
        setCategories(parsed);
        setPagination(data.pagination || initialPagination);

        const urlToUpdate = new URL(window.location.href);
        if (params.page)
          urlToUpdate.searchParams.set("page", params.page.toString());
        if (params.limit)
          urlToUpdate.searchParams.set("limit", params.limit.toString());
        if (params.search)
          urlToUpdate.searchParams.set("search", params.search);
        else urlToUpdate.searchParams.delete("search");
        if (params.sort) urlToUpdate.searchParams.set("sort", params.sort);
        if (params.order) urlToUpdate.searchParams.set("order", params.order);
        if (showTrashed) urlToUpdate.searchParams.set("trashed", "true");
        else urlToUpdate.searchParams.delete("trashed");
        window.history.pushState({}, "", urlToUpdate.toString());
      } catch (err) {
        console.error("Error fetching categories:", err);
        toast.error("Failed to load categories. Please try again.");
      } finally {
        setIsLoadingCategories(false);
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

  // Trigger fetch on search change
  useEffect(() => {
    if (searchQuery !== prevSearchQueryRef.current) {
      prevSearchQueryRef.current = searchQuery;
      fetchCategories({
        page: 1,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        sort: sort.field,
        order: sort.order,
      });
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

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
        (sum, cat) => sum + cat.productCount,
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
      setSearchQuery(localSearch);
    },
    [localSearch],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      setSort({ field, order: newOrder });
      fetchCategories({
        page: pagination.page,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        sort: field,
        order: newOrder,
      });
    },
    [
      fetchCategories,
      pagination.page,
      pagination.limit,
      searchQuery,
      sort.field,
      sort.order,
    ],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      fetchCategories({
        page: newPage,
        limit: pagination.limit,
        search: searchQuery.trim() || undefined,
        sort: sort.field,
        order: sort.order,
      });
    },
    [
      fetchCategories,
      pagination.totalPages,
      pagination.limit,
      searchQuery,
      sort.field,
      sort.order,
    ],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      fetchCategories({
        page: 1,
        limit: newLimit,
        search: searchQuery.trim() || undefined,
        sort: sort.field,
        order: sort.order,
      });
    },
    [fetchCategories, searchQuery, sort.field, sort.order],
  );

  const handleDelete = useCallback(async () => {
    if (!categoryToDelete) return;
    setIsActionLoading(true);
    const idToDelete = categoryToDelete;
    setCategoryToDelete(null);

    try {
      const response = await fetch(
        `/api/v1/admin/categories/${idToDelete}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        let errorData: Record<string, unknown> = {};
        try {
          errorData = await response.json();
        } catch (parseError) {
          console.error("Failed to parse error response:", parseError);
        }

        if (errorData.error && errorData.suggestion) {
          toast.error(`Cannot Delete Category: ${errorData.error} ${errorData.suggestion}`);
        } else {
          toast.error("Failed to move category to trash.");
        }
        return;
      }

      toast.success("Category moved to trash.");
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
      toast.error("Failed to move category to trash.");
    } finally {
      setIsActionLoading(false);
    }
  }, [categoryToDelete]);

  const handlePermanentDelete = useCallback(async () => {
    if (!categoryToDelete) return;
    setIsActionLoading(true);
    const idToDelete = categoryToDelete;
    setCategoryToDelete(null);

    try {
      const response = await fetch(
        `/api/v1/admin/categories/${idToDelete}/permanent`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        let errorData: Record<string, unknown> = {};
        try {
          errorData = await response.json();
        } catch (parseError) {
          console.error(
            "Failed to parse permanent delete error response:",
            parseError,
          );
        }

        if (errorData.error && errorData.suggestion) {
          toast.error(`Cannot Delete Category: ${errorData.error} ${errorData.suggestion}`);
        } else {
          toast.error("Failed to permanently delete category.");
        }
        return;
      }

      toast.success("Category permanently deleted.");
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
      toast.error("Failed to permanently delete category.");
    } finally {
      setIsActionLoading(false);
    }
  }, [categoryToDelete]);

  const handleRestore = useCallback(async (id: string) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/categories/${id}/restore`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Failed to restore category");

      toast.success("Category restored successfully.");
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
      toast.error("Failed to restore category.");
    } finally {
      setIsActionLoading(false);
    }
  }, []);

  const handleBulkDelete = useCallback(() => {
    if (selectedCategories.size > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [selectedCategories]);

  const confirmBulkDelete = useCallback(async () => {
    if (selectedCategories.size === 0) return;
    setIsActionLoading(true);
    const idsToDelete = Array.from(selectedCategories);
    setIsConfirmBulkDeleteOpen(false);

    try {
      const response = await fetch("/api/v1/admin/categories/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryIds: idsToDelete,
          permanent: showTrashed,
        }),
      });

      if (!response.ok) {
        let errorData: Record<string, unknown> = {};
        try {
          errorData = await response.json();
        } catch (parseError) {
          console.error(
            "Failed to parse bulk delete error response:",
            parseError,
          );
        }

        if (errorData.error && errorData.suggestion) {
          const affectedProducts = errorData.affectedProducts as
            | Array<{ name: string }>
            | undefined;
          const productList = affectedProducts
            ? affectedProducts
                .slice(0, 3)
                .map((p) => p.name)
                .join(", ")
            : "";

          const fullMessage = productList
            ? `${errorData.error} ${errorData.suggestion} Affected products: ${productList}${(affectedProducts?.length ?? 0) > 3 ? "..." : ""}`
            : `${errorData.error} ${errorData.suggestion}`;

          toast.error(`Cannot Delete Categories: ${fullMessage}`);
        } else {
          toast.error("Failed to process bulk delete.");
        }
        return;
      }

      toast.success(
        `${idsToDelete.length} categories ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
      );
      setCategories((prev) =>
        prev.filter((p) => !idsToDelete.includes(p.id)),
      );
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToDelete.length),
      }));
      setSelectedCategories(new Set());
    } catch (error) {
      console.error("Error bulk deleting categories:", error);
      toast.error("Failed to process bulk delete.");
    } finally {
      setIsActionLoading(false);
    }
  }, [selectedCategories, showTrashed]);

  const confirmBulkRestore = useCallback(async () => {
    if (selectedCategories.size === 0) return;
    setIsActionLoading(true);
    const idsToRestore = Array.from(selectedCategories);
    setIsConfirmBulkRestoreOpen(false);

    try {
      const response = await fetch("/api/v1/admin/categories/bulk-restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryIds: idsToRestore }),
      });
      if (!response.ok) throw new Error("Failed to restore categories");

      toast.success(
        `Restored ${idsToRestore.length} categories successfully`,
      );
      setCategories((prev) =>
        prev.filter((p) => !idsToRestore.includes(p.id)),
      );
      setPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToRestore.length),
      }));
      setSelectedCategories(new Set());
    } catch (error) {
      console.error("Error restoring categories:", error);
      toast.error("Failed to restore categories.");
    } finally {
      setIsActionLoading(false);
    }
  }, [selectedCategories]);

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
    setSearchQuery("");
    fetchCategories({
      page: 1,
      limit: pagination.limit,
      sort: sort.field,
      order: sort.order,
    });
  }, [fetchCategories, pagination.limit, sort.field, sort.order]);

  const toggleTrash = useCallback(() => {
    const url = new URL(window.location.href);
    if (showTrashed) {
      url.searchParams.delete("trashed");
    } else {
      url.searchParams.set("trashed", "true");
    }
    void navigateTo(url.toString());
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
    sort,
    selectedCategories,
    categoryToDelete,
    setCategoryToDelete,
    isActionLoading,
    isConfirmBulkDeleteOpen,
    setIsConfirmBulkDeleteOpen,
    isConfirmBulkRestoreOpen,
    setIsConfirmBulkRestoreOpen,
    isLoadingCategories,
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
