import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { navigateTo } from "@/lib/client/navigate";
import type { Customer, SortField, CustomerListPagination } from "./useCustomerListState";

interface UseCustomerListActionsProps {
  showTrashed: boolean;
  initialPagination: CustomerListPagination;
  searchQuery: string;
  localSearch: string;
  sort: { field: SortField; order: "asc" | "desc" };
  currentPagination: CustomerListPagination;
  selectedCustomers: Set<string>;
  searchTimeoutRef: React.RefObject<number | undefined>;
  prevSearchQueryRef: React.RefObject<string>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setLocalSearch: React.Dispatch<React.SetStateAction<string>>;
  setSort: React.Dispatch<React.SetStateAction<{ field: SortField; order: "asc" | "desc" }>>;
  setSelectedCustomers: React.Dispatch<React.SetStateAction<Set<string>>>;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setIsLoadingCustomers: React.Dispatch<React.SetStateAction<boolean>>;
  setDisplayCustomers: React.Dispatch<React.SetStateAction<Customer[]>>;
  setCurrentPagination: React.Dispatch<React.SetStateAction<CustomerListPagination>>;
  setDialogState: React.Dispatch<React.SetStateAction<{ action: "delete" | "bulk-delete"; id?: string } | undefined>>;
}

export function useCustomerListActions({
  showTrashed,
  initialPagination,
  searchQuery,
  localSearch,
  sort,
  currentPagination,
  selectedCustomers,
  searchTimeoutRef,
  prevSearchQueryRef,
  setSearchQuery,
  setSort,
  setSelectedCustomers,
  setIsProcessing,
  setIsLoadingCustomers,
  setDisplayCustomers,
  setCurrentPagination,
  setDialogState,
}: UseCustomerListActionsProps) {
  const fetchCustomers = useCallback(
    async (params: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: SortField;
      order?: "asc" | "desc";
    }) => {
      setIsLoadingCustomers(true);
      try {
        const url = new URL("/api/v1/admin/customers", window.location.origin);
        if (params.page) url.searchParams.set("page", params.page.toString());
        if (params.limit) url.searchParams.set("limit", params.limit.toString());
        if (params.search) url.searchParams.set("search", params.search);
        if (params.sort) url.searchParams.set("sort", params.sort);
        if (params.order) url.searchParams.set("order", params.order);
        if (showTrashed) url.searchParams.set("trashed", "true");

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error("Failed to fetch customers");
        const json = await res.json();
        const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;

        const parsed = (data.customers || []).map((c: Record<string, unknown>) => ({
          ...c,
          lastOrderAt: c.lastOrderAt ? new Date(c.lastOrderAt as string) : null,
          createdAt: c.createdAt ? new Date(c.createdAt as string) : new Date(0),
          updatedAt: c.updatedAt ? new Date(c.updatedAt as string) : new Date(0),
        }));
        setDisplayCustomers(parsed);
        setCurrentPagination(data.pagination || initialPagination);

        const urlToUpdate = new URL(window.location.href);
        if (params.page) urlToUpdate.searchParams.set("page", params.page.toString());
        if (params.limit) urlToUpdate.searchParams.set("limit", params.limit.toString());
        if (params.search) urlToUpdate.searchParams.set("search", params.search);
        else urlToUpdate.searchParams.delete("search");
        if (params.sort) urlToUpdate.searchParams.set("sort", params.sort);
        if (params.order) urlToUpdate.searchParams.set("order", params.order);
        if (showTrashed) urlToUpdate.searchParams.set("trashed", "true");
        else urlToUpdate.searchParams.delete("trashed");
        window.history.pushState({}, "", urlToUpdate.toString());
      } catch (err) {
        console.error("Error fetching customers:", err);
        toast.error("Failed to load customers. Please try again.");
      } finally {
        setIsLoadingCustomers(false);
      }
    },
    [showTrashed, initialPagination, setIsLoadingCustomers, setDisplayCustomers, setCurrentPagination],
  );

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) window.clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = window.setTimeout(() => {
      if (localSearch !== searchQuery) setSearchQuery(localSearch);
    }, 500);
    return () => {
      if (searchTimeoutRef.current) window.clearTimeout(searchTimeoutRef.current);
    };
  }, [localSearch, searchQuery, setSearchQuery, searchTimeoutRef]);

  // Search query changed
  useEffect(() => {
    if (searchQuery !== prevSearchQueryRef.current) {
      prevSearchQueryRef.current = searchQuery;
      fetchCustomers({
        page: 1,
        limit: currentPagination.limit,
        search: searchQuery.trim() || undefined,
        sort: sort.field,
        order: sort.order,
      });
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = useCallback(
    (e?: React.SyntheticEvent) => {
      e?.preventDefault();
      setSearchQuery(localSearch);
    },
    [localSearch, setSearchQuery],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      setSort({ field, order: newOrder });
      fetchCustomers({
        page: currentPagination.page,
        limit: currentPagination.limit,
        search: searchQuery.trim() || undefined,
        sort: field,
        order: newOrder,
      });
    },
    [fetchCustomers, currentPagination.page, currentPagination.limit, searchQuery, sort.field, sort.order, setSort],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      if (newPage < 1 || newPage > currentPagination.totalPages) return;
      fetchCustomers({
        page: newPage,
        limit: currentPagination.limit,
        search: searchQuery.trim() || undefined,
        sort: sort.field,
        order: sort.order,
      });
    },
    [fetchCustomers, currentPagination.totalPages, currentPagination.limit, searchQuery, sort.field, sort.order],
  );

  const handleLimitChange = useCallback(
    (newLimit: number) => {
      fetchCustomers({
        page: 1,
        limit: newLimit,
        search: searchQuery.trim() || undefined,
        sort: sort.field,
        order: sort.order,
      });
    },
    [fetchCustomers, searchQuery, sort.field, sort.order],
  );

  const toggleTrashView = useCallback(() => {
    void navigateTo(
      showTrashed ? "/admin/customers" : "/admin/customers?trashed=true",
    );
  }, [showTrashed]);

  const performApiAction = useCallback(
    async (
      action: () => Promise<Response>,
      {
        successTitle,
        successDescription,
        errorTitle,
        optimisticUpdate,
      }: {
        successTitle: string;
        successDescription: string;
        errorTitle: string;
        optimisticUpdate: () => void;
      },
    ) => {
      setIsProcessing(true);
      try {
        const response = await action();
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "An unknown error occurred.");
        }
        optimisticUpdate();
        setSelectedCustomers(new Set());
        toast.success(successTitle, { description: successDescription });
      } catch (error) {
        console.error(`${errorTitle}:`, error);
        toast.error(errorTitle, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsProcessing(false);
        setDialogState(undefined);
      }
    },
    [setIsProcessing, setSelectedCustomers, setDialogState],
  );

  const handleDelete = useCallback((id: string) => {
    performApiAction(
      () => fetch(`/api/v1/admin/customers/${id}`, { method: "DELETE" }),
      {
        successTitle: "Customer Moved to Trash",
        successDescription: "The customer record has been moved to the trash.",
        errorTitle: "Failed to Trash Customer",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) => prev.filter((c) => c.id !== id));
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - 1),
          }));
        },
      },
    );
  }, [performApiAction, setDisplayCustomers, setCurrentPagination]);

  const handlePermanentDelete = useCallback((id: string) => {
    performApiAction(
      () => fetch(`/api/v1/admin/customers/${id}/permanent`, { method: "DELETE" }),
      {
        successTitle: "Customer Permanently Deleted",
        successDescription: "The customer record has been permanently removed.",
        errorTitle: "Deletion Failed",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) => prev.filter((c) => c.id !== id));
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - 1),
          }));
        },
      },
    );
  }, [performApiAction, setDisplayCustomers, setCurrentPagination]);

  const handleRestore = useCallback((id: string) => {
    performApiAction(
      () => fetch(`/api/v1/admin/customers/${id}/restore`, { method: "POST" }),
      {
        successTitle: "Customer Restored",
        successDescription: "The customer has been successfully restored.",
        errorTitle: "Restore Failed",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) => prev.filter((c) => c.id !== id));
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - 1),
          }));
        },
      },
    );
  }, [performApiAction, setDisplayCustomers, setCurrentPagination]);

  const handleBulkAction = useCallback(() => {
    const ids = Array.from(selectedCustomers);
    performApiAction(
      () =>
        fetch("/api/v1/admin/customers/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerIds: ids, permanent: showTrashed }),
        }),
      {
        successTitle: "Bulk Action Successful",
        successDescription: `${ids.length} customers have been ${showTrashed ? "permanently deleted" : "moved to trash"}.`,
        errorTitle: "Bulk Action Failed",
        optimisticUpdate: () => {
          setDisplayCustomers((prev) =>
            prev.filter((c) => !ids.includes(c.id)),
          );
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - ids.length),
          }));
        },
      },
    );
  }, [selectedCustomers, showTrashed, performApiAction, setDisplayCustomers, setCurrentPagination]);

  return {
    fetchCustomers,
    handleSearch,
    handleSort,
    handlePageChange,
    handleLimitChange,
    toggleTrashView,
    handleDelete,
    handlePermanentDelete,
    handleRestore,
    handleBulkAction,
  };
}
