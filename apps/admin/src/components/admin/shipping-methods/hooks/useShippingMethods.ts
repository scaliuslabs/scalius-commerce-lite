import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { unwrapEnvelope } from "@/lib/api-helpers";

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
        const params = new URLSearchParams();
        params.append("page", pageToFetch.toString());
        params.append("limit", limitToFetch.toString());
        if (currentSearch) params.append("search", currentSearch);
        params.append("sort", currentSort.field);
        params.append("order", currentSort.order);
        if (currentShowTrashed) params.append("trashed", "true");

        const response = await fetch(
          `/api/v1/admin/settings/shipping-methods?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch shipping methods");
        const json = await response.json();
        const data = unwrapEnvelope(json);

        setMethods(data.shippingMethods || []);
        setPagination(
          data.pagination || {
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
    const url = new URL(window.location.href);
    setSearchQuery(url.searchParams.get("search") || "");
    const sortFieldFromUrl = url.searchParams.get("sort") as SortField | null;
    const sortOrderFromUrl = url.searchParams.get("order") as SortOrder | null;
    if (sortFieldFromUrl && sortOrderFromUrl) {
      setSort({ field: sortFieldFromUrl, order: sortOrderFromUrl });
    }
    setShowTrashed(url.searchParams.get("trashed") === "true");
  }, []);

  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      if (e) e.preventDefault();
      const url = new URL(window.location.href);
      if (searchQuery.trim()) {
        url.searchParams.set("search", searchQuery.trim());
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.set("page", "1");
      window.history.pushState({}, "", url.toString());
      fetchMethods(1, pagination.limit, searchQuery, sort, showTrashed);
    },
    [searchQuery, pagination.limit, sort, showTrashed, fetchMethods],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder: SortOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      const newSort = { field, order: newOrder };
      setSort(newSort);
      const url = new URL(window.location.href);
      url.searchParams.set("sort", field);
      url.searchParams.set("order", newOrder);
      url.searchParams.set("page", "1");
      window.history.pushState({}, "", url.toString());
      fetchMethods(1, pagination.limit, searchQuery, newSort, showTrashed);
    },
    [sort, pagination.limit, searchQuery, showTrashed, fetchMethods],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      const url = new URL(window.location.href);
      url.searchParams.set("page", newPage.toString());
      window.history.pushState({}, "", url.toString());
      fetchMethods(newPage, pagination.limit, searchQuery, sort, showTrashed);
    },
    [pagination.totalPages, pagination.limit, searchQuery, sort, showTrashed, fetchMethods],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      const url = new URL(window.location.href);
      url.searchParams.set("limit", newLimit.toString());
      url.searchParams.set("page", "1");
      window.history.pushState({}, "", url.toString());
      fetchMethods(1, newLimit, searchQuery, sort, showTrashed);
    },
    [searchQuery, sort, showTrashed, fetchMethods],
  );

  const toggleTrash = useCallback(() => {
    const newShowTrashed = !showTrashed;
    setShowTrashed(newShowTrashed);
    const url = new URL(window.location.href);
    if (newShowTrashed) {
      url.searchParams.set("trashed", "true");
    } else {
      url.searchParams.delete("trashed");
    }
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchMethods(1, pagination.limit, searchQuery, sort, newShowTrashed);
  }, [showTrashed, pagination.limit, searchQuery, sort, fetchMethods]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchMethods(1, pagination.limit, "", sort, showTrashed);
  }, [pagination.limit, sort, showTrashed, fetchMethods]);

  const handleFormSubmit = async (
    formData: Partial<ShippingMethod>,
    editingMethodId: string | null,
  ): Promise<boolean> => {
    setIsActionLoading(true);
    const url = editingMethodId
      ? `/api/v1/admin/settings/shipping-methods/${editingMethodId}`
      : "/api/v1/admin/settings/shipping-methods";
    const method = editingMethodId ? "PUT" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error ||
            (editingMethodId ? "Failed to update" : "Failed to create") +
              " shipping method",
        );
      }
      toast.success(`Shipping method ${editingMethodId ? "updated" : "created"} successfully.`);
      fetchMethods(editingMethodId ? pagination.page : 1);
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "An unexpected error occurred.";
      toast.error(msg);
      return false;
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/shipping-methods/${id}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204)
        throw new Error("Failed to move to trash");

      toast.success("Shipping method moved to trash.");
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      toast.error("Failed to move to trash.");
    } finally {
      setIsActionLoading(false);
    }
  };

  const handlePermanentDelete = async (id: string) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/shipping-methods/${id}/permanent-delete`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204)
        throw new Error("Failed to permanently delete method");

      toast.success("Shipping method permanently deleted.");
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      toast.error("Failed to permanently delete method.");
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (id: string) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/shipping-methods/${id}/restore`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Failed to restore shipping method");
      toast.success("Shipping method restored successfully.");
      fetchMethods(pagination.page);
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      toast.error("Failed to restore shipping method.");
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
        let response;
        if (action === "trash") {
          response = await fetch(`/api/v1/admin/settings/shipping-methods/${id}`, {
            method: "DELETE",
          });
        } else if (action === "deletePermanent") {
          response = await fetch(
            `/api/v1/admin/settings/shipping-methods/${id}/permanent-delete`,
            { method: "DELETE" },
          );
        } else if (action === "restore") {
          response = await fetch(
            `/api/v1/admin/settings/shipping-methods/${id}/restore`,
            { method: "POST" },
          );
        }
        if (response && (response.ok || response.status === 204)) {
          successCount++;
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
      const msg = error instanceof Error ? error.message : `Failed to ${action} methods.`;
      toast.error(msg);
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
