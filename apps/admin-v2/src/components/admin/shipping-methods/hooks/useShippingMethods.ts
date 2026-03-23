import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { getServerFnError } from "@/lib/api-helpers";
import {
  getShippingMethods,
  createShippingMethod,
  updateShippingMethod,
  deleteShippingMethod,
  permanentDeleteShippingMethod,
  restoreShippingMethod,
} from "@/lib/api.functions";

// Local type replacing @scalius/database/schema import
export interface ShippingMethod {
  id: string;
  name: string;
  fee: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type SortField =
  | "name"
  | "fee"
  | "isActive"
  | "sortOrder"
  | "createdAt"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

interface PaginationState {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export function useShippingMethods() {
  const navigate = useNavigate();
  const [methods, setMethods] = useState<ShippingMethod[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    total: 0,
    page: 1,
    limit: 10,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "sortOrder",
    order: "asc",
  });
  const [selectedMethods, setSelectedMethods] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [showTrashed, setShowTrashed] = useState(false);

  const fetchMethods = useCallback(
    async (
      pageToFetch = pagination.page,
      limitToFetch = pagination.limit,
      currentSearch = searchQuery,
      currentSort = sort,
      currentShowTrashed = showTrashed,
    ) => {
      setIsLoading(true);
      try {
        const data = await getShippingMethods({
          data: {
            page: pageToFetch,
            limit: limitToFetch,
            ...(currentSearch ? { search: currentSearch } : {}),
            sort: currentSort.field,
            order: currentSort.order,
            ...(currentShowTrashed ? { trashed: true } : {}),
          },
        }) as Record<string, unknown>;

        setMethods((data.shippingMethods || []) as ShippingMethod[]);
        setPagination(
          (data.pagination as PaginationState) || {
            total: 0,
            page: 1,
            limit: 10,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        );
      } catch (error: unknown) {
        console.error("Error fetching shipping methods:", error);
        toast.error("Could not load shipping methods.");
      } finally {
        setIsLoading(false);
      }
    },
    [pagination.page, pagination.limit, searchQuery, sort, showTrashed],
  );

  useEffect(() => {
    fetchMethods();
  }, [fetchMethods]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setSearchQuery(params.get("search") || "");
    const sortFieldFromUrl = params.get("sort") as SortField | null;
    const sortOrderFromUrl = params.get("order") as SortOrder | null;
    if (sortFieldFromUrl && sortOrderFromUrl) {
      setSort({ field: sortFieldFromUrl, order: sortOrderFromUrl });
    }
    setShowTrashed(params.get("trashed") === "true");
  }, []);

  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      if (e) e.preventDefault();
      void navigate({
        search: ((prev: any) => {
          const next = { ...prev, page: 1 };
          if (searchQuery.trim()) next.search = searchQuery.trim();
          else delete next.search;
          return next;
        }) as any,
        replace: true,
      });
      fetchMethods(1, pagination.limit, searchQuery, sort, showTrashed);
    },
    [searchQuery, pagination.limit, sort, showTrashed, fetchMethods, navigate],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder: SortOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      const newSort = { field, order: newOrder };
      setSort(newSort);
      void navigate({
        search: ((prev: any) => ({
          ...prev,
          sort: field,
          order: newOrder,
          page: 1,
        })) as any,
        replace: true,
      });
      fetchMethods(1, pagination.limit, searchQuery, newSort, showTrashed);
    },
    [sort, pagination.limit, searchQuery, showTrashed, fetchMethods, navigate],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      void navigate({
        search: ((prev: any) => ({ ...prev, page: newPage })) as any,
        replace: true,
      });
      fetchMethods(newPage, pagination.limit, searchQuery, sort, showTrashed);
    },
    [pagination.totalPages, pagination.limit, searchQuery, sort, showTrashed, fetchMethods, navigate],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      void navigate({
        search: ((prev: any) => ({
          ...prev,
          limit: newLimit,
          page: 1,
        })) as any,
        replace: true,
      });
      fetchMethods(1, newLimit, searchQuery, sort, showTrashed);
    },
    [searchQuery, sort, showTrashed, fetchMethods, navigate],
  );

  const toggleTrash = useCallback(() => {
    const newShowTrashed = !showTrashed;
    setShowTrashed(newShowTrashed);
    void navigate({
      search: ((prev: any) => {
        const next = { ...prev, page: 1 };
        if (newShowTrashed) next.trashed = "true";
        else delete next.trashed;
        return next;
      }) as any,
      replace: true,
    });
    fetchMethods(1, pagination.limit, searchQuery, sort, newShowTrashed);
  }, [showTrashed, pagination.limit, searchQuery, sort, fetchMethods, navigate]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    void navigate({
      search: ((prev: any) => {
        const next = { ...prev, page: 1 };
        delete next.search;
        return next;
      }) as any,
      replace: true,
    });
    fetchMethods(1, pagination.limit, "", sort, showTrashed);
  }, [pagination.limit, sort, showTrashed, fetchMethods, navigate]);

  const handleFormSubmit = async (
    formData: Partial<ShippingMethod>,
    editingMethodId: string | null,
  ): Promise<boolean> => {
    setIsActionLoading(true);
    try {
      if (editingMethodId) {
        await updateShippingMethod({
          data: { id: editingMethodId, update: formData as Record<string, unknown> },
        });
      } else {
        await createShippingMethod({ data: formData as Record<string, unknown> });
      }
      toast.success(`Shipping method ${editingMethodId ? "updated" : "created"} successfully.`);
      fetchMethods(editingMethodId ? pagination.page : 1);
      return true;
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "An unexpected error occurred."));
      return false;
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsActionLoading(true);
    try {
      await deleteShippingMethod({ data: { id } });
      toast.success("Shipping method moved to trash.");
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to move to trash."));
    } finally {
      setIsActionLoading(false);
    }
  };

  const handlePermanentDelete = async (id: string) => {
    setIsActionLoading(true);
    try {
      await permanentDeleteShippingMethod({ data: { id } });
      toast.success("Shipping method permanently deleted.");
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to permanently delete method."));
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (id: string) => {
    setIsActionLoading(true);
    try {
      await restoreShippingMethod({ data: { id } });
      toast.success("Shipping method restored successfully.");
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to restore shipping method."));
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleBulkAction = async (
    action: "trash" | "deletePermanent" | "restore",
  ) => {
    if (selectedMethods.size === 0) return;
    setIsActionLoading(true);
    const ids = Array.from(selectedMethods);

    try {
      let successCount = 0;
      for (const id of ids) {
        try {
          if (action === "trash") {
            await deleteShippingMethod({ data: { id } });
          } else if (action === "deletePermanent") {
            await permanentDeleteShippingMethod({ data: { id } });
          } else if (action === "restore") {
            await restoreShippingMethod({ data: { id } });
          }
          successCount++;
        } catch {
          // Individual failures are counted below
        }
      }

      if (successCount > 0) {
        toast.success(
          `${successCount} of ${ids.length} methods ${action === "trash" ? "moved to trash" : action === "deletePermanent" ? "permanently deleted" : "restored"}.`,
        );
      }
      if (successCount < ids.length) {
        toast.info(`Failed to process ${ids.length - successCount} methods.`);
      }

      fetchMethods(pagination.page);
      setSelectedMethods(new Set());
    } catch (error: unknown) {
      toast.error(getServerFnError(error, `Failed to ${action} methods.`));
    } finally {
      setIsActionLoading(false);
    }
  };

  const selectAllCheckedState = useMemo(() => {
    if (methods.length === 0) return false;
    if (selectedMethods.size === 0) return false;
    if (selectedMethods.size === methods.length) return true;
    return "indeterminate" as const;
  }, [selectedMethods.size, methods.length]);

  const toggleMethodSelection = useCallback(
    (methodId: string, checked: boolean) => {
      setSelectedMethods((prev) => {
        const newSelection = new Set(prev);
        if (checked) newSelection.add(methodId);
        else newSelection.delete(methodId);
        return newSelection;
      });
    },
    [],
  );

  const toggleAllMethods = useCallback(
    (checked: boolean | "indeterminate") => {
      const isChecked = typeof checked === "boolean" ? checked : false;
      if (isChecked) setSelectedMethods(new Set(methods.map((m) => m.id)));
      else setSelectedMethods(new Set());
    },
    [methods],
  );

  const hasActiveFilters = searchQuery.trim().length > 0;

  return {
    methods,
    pagination,
    searchQuery,
    setSearchQuery,
    sort,
    selectedMethods,
    isLoading,
    isActionLoading,
    showTrashed,
    hasActiveFilters,
    selectAllCheckedState,
    handleSearch,
    handleSort,
    handlePageChange,
    handleLimitChange,
    toggleTrash,
    clearFilters,
    handleFormSubmit,
    handleDelete,
    handlePermanentDelete,
    handleRestore,
    handleBulkAction,
    toggleMethodSelection,
    toggleAllMethods,
  };
}
