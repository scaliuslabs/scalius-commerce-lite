import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { shippingMethodsQueryOptions } from "~/lib/api-query-options/shipping-methods";
import { queryKeys } from "~/lib/query-keys";
import {
  useCreateShippingMethod,
  useUpdateShippingMethod,
  useDeleteShippingMethod,
  usePermanentDeleteShippingMethod,
  useRestoreShippingMethod,
} from "~/lib/api-mutations/shipping-methods";
import {
  deleteShippingMethod as deleteShippingMethodFn,
  permanentDeleteShippingMethod as permanentDeleteShippingMethodFn,
  restoreShippingMethod as restoreShippingMethodFn,
  type ShippingMethod,
  type ShippingMethodWriteInput,
  type ShippingMethodsPagination,
  type ShippingMethodsQueryInput,
} from "@/lib/api-functions/shipping-methods";
import { getServerFnError } from "@/lib/api-helpers";

export type { ShippingMethod };

export type SortField =
  | "name"
  | "fee"
  | "isActive"
  | "sortOrder"
  | "createdAt"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

const DEFAULT_PAGINATION: ShippingMethodsPagination = {
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false,
};

const EMPTY_SHIPPING_METHODS: ShippingMethod[] = [];

export function useShippingMethods() {
  const queryClient = useQueryClient();

  // Local filter/sort/pagination state (sub-tab component, no URL params)
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "sortOrder",
    order: "asc",
  });
  const [selectedMethods, setSelectedMethods] = useState<Set<string>>(
    new Set(),
  );
  const [showTrashed, setShowTrashed] = useState(false);
  const [isBulkLoading, setIsBulkLoading] = useState(false);

  // Build query params
  const queryParams = useMemo(() => {
    const params: ShippingMethodsQueryInput = {
      page,
      limit,
      sort: sort.field,
      order: sort.order,
    };
    if (appliedSearch) params.search = appliedSearch;
    if (showTrashed) params.trashed = true;
    return params;
  }, [page, limit, sort.field, sort.order, appliedSearch, showTrashed]);

  // Main list query
  const { data, isLoading, isFetching } = useQuery({
    ...shippingMethodsQueryOptions(queryParams),
    placeholderData: (prev) => prev,
  });

  // Parse response
  const methods = data?.shippingMethods ?? EMPTY_SHIPPING_METHODS;
  const pagination = data?.pagination ?? DEFAULT_PAGINATION;

  // Mutations
  const createMutation = useCreateShippingMethod();
  const updateMutation = useUpdateShippingMethod();
  const deleteMutation = useDeleteShippingMethod();
  const permanentDeleteMutation = usePermanentDeleteShippingMethod();
  const restoreMutation = useRestoreShippingMethod();

  const isActionLoading =
    isBulkLoading ||
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    restoreMutation.isPending;

  // Handlers
  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      if (e) e.preventDefault();
      setAppliedSearch(searchQuery.trim());
      setPage(1);
    },
    [searchQuery],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder: SortOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      setSort({ field, order: newOrder });
      setPage(1);
    },
    [sort],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > pagination.totalPages) return;
      setPage(newPage);
    },
    [pagination.totalPages],
  );

  const handleLimitChange = useCallback((newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
  }, []);

  const toggleTrash = useCallback(() => {
    setShowTrashed((prev) => !prev);
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setAppliedSearch("");
    setPage(1);
  }, []);

  const handleFormSubmit = useCallback(
    async (
      formData: Partial<ShippingMethod>,
      editingMethodId: string | null,
    ): Promise<boolean> => {
      try {
        if (editingMethodId) {
          await updateMutation.mutateAsync({
            id: editingMethodId,
            update: formData as ShippingMethodWriteInput,
          });
        } else {
          await createMutation.mutateAsync(
            formData as ShippingMethodWriteInput,
          );
          setPage(1);
        }
        return true;
      } catch {
        return false;
      }
    },
    [updateMutation, createMutation],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteMutation.mutateAsync({ id });
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [deleteMutation],
  );

  const handlePermanentDelete = useCallback(
    async (id: string) => {
      await permanentDeleteMutation.mutateAsync({ id });
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [permanentDeleteMutation],
  );

  const handleRestore = useCallback(
    async (id: string) => {
      await restoreMutation.mutateAsync({ id });
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [restoreMutation],
  );

  const handleBulkAction = useCallback(
    async (action: "trash" | "deletePermanent" | "restore") => {
      if (selectedMethods.size === 0) return;
      setIsBulkLoading(true);
      const ids = Array.from(selectedMethods);

      try {
        let successCount = 0;
        for (const id of ids) {
          try {
            if (action === "trash") {
              await deleteShippingMethodFn({ data: { id } });
            } else if (action === "deletePermanent") {
              await permanentDeleteShippingMethodFn({ data: { id } });
            } else if (action === "restore") {
              await restoreShippingMethodFn({ data: { id } });
            }
            successCount++;
          } catch {
            // Individual failures counted below
          }
        }

        if (successCount > 0) {
          toast.success(
            `${successCount} of ${ids.length} methods ${action === "trash" ? "moved to trash" : action === "deletePermanent" ? "permanently deleted" : "restored"}.`,
          );
        }
        if (successCount < ids.length) {
          toast.info(
            `Failed to process ${ids.length - successCount} methods.`,
          );
        }

        queryClient.invalidateQueries({
          queryKey: queryKeys.settings.shippingMethods(),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.settings.checkoutReadiness(),
        });
        setSelectedMethods(new Set());
      } catch (error: unknown) {
        toast.error(
          getServerFnError(error, `Failed to ${action} methods.`),
        );
      } finally {
        setIsBulkLoading(false);
      }
    },
    [selectedMethods, queryClient],
  );

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
    isLoading: isLoading || isFetching,
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
