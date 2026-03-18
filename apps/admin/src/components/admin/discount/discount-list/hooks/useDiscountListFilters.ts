import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { navigateTo } from "@/lib/client/navigate";
import { formatPrice } from "@scalius/shared/currency";

export type SortField =
  | "code"
  | "type"
  | "value"
  | "startDate"
  | "endDate"
  | "createdAt"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface DiscountItem {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  maxUsesPerOrder: number | null;
  maxUses: number | null;
  limitOnePerCustomer: boolean;
  combineWithProductDiscounts: boolean;
  combineWithOrderDiscounts: boolean;
  combineWithShippingDiscounts: boolean;
  customerSegment: string | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  relatedProducts: { buy: string[]; get: string[] };
  relatedCollections: { buy: string[]; get: string[] };
  usageCount?: number;
  totalDiscountAmount?: number;
}

export interface DiscountListPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function useDiscountListFilters(
  discounts: DiscountItem[],
  pagination: DiscountListPagination,
  initialSearchQuery: string,
  initialSort: { field: SortField; order: SortOrder },
  showTrashed: boolean,
  symbol: string,
) {
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [sort, setSort] = useState(initialSort);
  const [selectedDiscounts, setSelectedDiscounts] = useState<Set<string>>(
    new Set(),
  );
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);
  const [permanentDeleteConfirmation, setPermanentDeleteConfirmation] =
    useState<string | null>(null);
  const [bulkActionConfirmation, setBulkActionConfirmation] = useState<
    "delete" | "restore" | null
  >(null);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [displayDiscounts, setDisplayDiscounts] = useState<DiscountItem[]>(
    discounts || [],
  );
  const [currentPagination, setCurrentPagination] = useState(pagination);

  // Sync props
  useEffect(() => {
    setDisplayDiscounts(discounts || []);
  }, [discounts]);

  useEffect(() => {
    setCurrentPagination(pagination);
  }, [pagination]);

  // URL sync
  useEffect(() => {
    const url = new URL(window.location.href);
    const typeFromUrl = url.searchParams.get("type");
    setActiveType(typeFromUrl);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as SortOrder,
    });
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
  }, [initialSort.field, initialSort.order, initialSearchQuery]);

  // Navigation handlers (SSR pattern via navigateTo)
  const handleSearch = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      const url = new URL(window.location.href);
      if (searchQuery.trim()) {
        url.searchParams.set("search", searchQuery.trim());
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.delete("page");
      void navigateTo(url.toString());
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
    void navigateTo(url.toString());
  }, []);

  const handlePageChange = useCallback((newPage: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", newPage.toString());
    void navigateTo(url.toString());
  }, []);

  const handleLimitChange = useCallback((newLimit: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set("limit", newLimit.toString());
    url.searchParams.delete("page");
    void navigateTo(url.toString());
  }, []);

  const handleEdit = useCallback((id: string) => {
    void navigateTo(`/admin/discounts/${id}/edit`);
  }, []);

  const handleTypeFilter = useCallback((type: string | null) => {
    const url = new URL(window.location.href);
    if (type) {
      url.searchParams.set("type", type);
    } else {
      url.searchParams.delete("type");
    }
    url.searchParams.delete("page");
    void navigateTo(url.toString());
  }, []);

  // API action handlers
  const handleDelete = useCallback((id: string) => {
    setDeleteConfirmation(id);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmation) return;
    const idToDelete = deleteConfirmation;
    setDeleteConfirmation(null);

    try {
      const response = await fetch(`/api/v1/admin/discounts/${idToDelete}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete discount");
      }
      toast.success("Discount moved to trash");
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== idToDelete));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error: unknown) {
      console.error("Error deleting discount:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete discount");
    }
  }, [deleteConfirmation]);

  const handlePermanentDelete = useCallback((id: string) => {
    setPermanentDeleteConfirmation(id);
  }, []);

  const handlePermanentDeleteConfirm = useCallback(async () => {
    if (!permanentDeleteConfirmation) return;
    const idToDelete = permanentDeleteConfirmation;
    setPermanentDeleteConfirmation(null);

    try {
      const response = await fetch(`/api/v1/admin/discounts/${idToDelete}/permanent`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to permanently delete discount");
      }
      toast.success("Discount deleted permanently");
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== idToDelete));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error: unknown) {
      console.error("Error permanently deleting discount:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete discount permanently");
    }
  }, [permanentDeleteConfirmation]);

  const handleRestore = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/v1/admin/discounts/${id}/restore`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to restore discount");
      }
      toast.success("Discount restored");
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== id));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error: unknown) {
      console.error("Error restoring discount:", error);
      toast.error(error instanceof Error ? error.message : "Failed to restore discount");
    }
  }, []);

  const handleBulkDelete = useCallback(() => {
    if (selectedDiscounts.size > 0) {
      setBulkActionConfirmation("delete");
    }
  }, [selectedDiscounts]);

  const handleBulkRestore = useCallback(() => {
    if (selectedDiscounts.size > 0) {
      setBulkActionConfirmation("restore");
    }
  }, [selectedDiscounts]);

  const handleBulkActionConfirm = useCallback(async () => {
    if (selectedDiscounts.size === 0 || !bulkActionConfirmation) return;

    const idsToDelete = Array.from(selectedDiscounts);
    setBulkActionConfirmation(null);

    try {
      const response = await fetch(
        bulkActionConfirmation === "restore"
          ? `/api/v1/admin/discounts/bulk-restore`
          : `/api/v1/admin/discounts/bulk-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            discountIds: idsToDelete,
            ...(bulkActionConfirmation === "delete"
              ? { permanent: showTrashed }
              : {}),
          }),
        },
      );
      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          error.error ||
          (bulkActionConfirmation === "restore"
            ? "Failed to restore discounts"
            : "Failed to delete discounts"),
        );
      }

      const title = bulkActionConfirmation === "restore"
        ? "Discounts restored"
        : showTrashed
          ? "Discounts deleted permanently"
          : "Discounts moved to trash";
      toast.success(title, {
        description: `${idsToDelete.length} discounts processed.`,
      });

      setDisplayDiscounts((prev) =>
        prev.filter((d) => !idsToDelete.includes(d.id)),
      );
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToDelete.length),
        totalPages: Math.ceil((prev.total - idsToDelete.length) / prev.limit),
      }));
      setSelectedDiscounts(new Set());
    } catch (error: unknown) {
      console.error("Error processing bulk discount action:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : bulkActionConfirmation === "restore"
            ? "Failed to restore discounts"
            : "Failed to delete discounts",
      );
    }
  }, [selectedDiscounts, showTrashed, bulkActionConfirmation]);

  const handleToggleStatus = useCallback(async (id: string, currentStatus: boolean) => {
    try {
      const response = await fetch(`/api/v1/admin/discounts/${id}/toggle-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !currentStatus }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update discount status");
      }
      toast.success(`Discount ${!currentStatus ? "activated" : "deactivated"}`);
      setDisplayDiscounts((prev) =>
        prev.map((discount) =>
          discount.id === id
            ? { ...discount, isActive: !currentStatus }
            : discount,
        ),
      );
    } catch (error: unknown) {
      console.error("Error toggling discount status:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update discount status");
    }
  }, []);

  const handleSelectItem = useCallback((id: string, checked: boolean) => {
    setSelectedDiscounts((prev) => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(id);
      } else {
        newSet.delete(id);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = useCallback(
    (checked: boolean | "indeterminate") => {
      const isChecked = typeof checked === "boolean" ? checked : false;
      if (isChecked) {
        setSelectedDiscounts(new Set(displayDiscounts.map((d) => d.id)));
      } else {
        setSelectedDiscounts(new Set());
      }
    },
    [displayDiscounts],
  );

  const selectAllCheckedState = useMemo(() => {
    if (selectedDiscounts.size === 0) return false;
    if (selectedDiscounts.size === displayDiscounts.length) return true;
    return "indeterminate" as const;
  }, [selectedDiscounts.size, displayDiscounts.length]);

  // Utility formatters
  const getSortIcon = useCallback((_field: SortField) => sort, [sort]);

  const formatDate = useCallback((dateString: string | null) => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return "Invalid Date";
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "Invalid Date";
    }
  }, []);

  const getTypeLabel = useCallback((type: string) => {
    switch (type) {
      case "amount_off_products":
        return "Amount Off Products";
      case "amount_off_order":
        return "Amount Off Order";
      case "free_shipping":
        return "Free Shipping";
      default:
        return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }
  }, []);

  const getDiscountValueDisplay = useCallback((discount: DiscountItem) => {
    switch (discount.valueType) {
      case "percentage":
        return `${discount.discountValue}% off`;
      case "fixed_amount":
        return `${formatPrice(discount.discountValue, { symbol })} off`;
      case "free":
        return "Free";
      default:
        return discount.discountValue.toString();
    }
  }, [symbol]);

  return {
    searchQuery,
    setSearchQuery,
    sort,
    selectedDiscounts,
    activeType,
    displayDiscounts,
    currentPagination,
    deleteConfirmation,
    setDeleteConfirmation,
    permanentDeleteConfirmation,
    setPermanentDeleteConfirmation,
    bulkActionConfirmation,
    setBulkActionConfirmation,
    selectAllCheckedState,
    handleSearch,
    handleSort,
    handlePageChange,
    handleLimitChange,
    handleEdit,
    handleDelete,
    handleDeleteConfirm,
    handlePermanentDelete,
    handlePermanentDeleteConfirm,
    handleRestore,
    handleBulkDelete,
    handleBulkRestore,
    handleBulkActionConfirm,
    handleTypeFilter,
    handleToggleStatus,
    handleSelectItem,
    handleSelectAll,
    getSortIcon,
    formatDate,
    getTypeLabel,
    getDiscountValueDisplay,
  };
}
