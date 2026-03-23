import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { formatPrice } from "@scalius/shared/currency";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { getServerFnError } from "~/lib/api-helpers";
import {
  deleteDiscount,
  deleteDiscountPermanent,
  restoreDiscount,
  bulkDeleteDiscounts,
  bulkRestoreDiscounts,
  toggleDiscountStatus,
} from "~/lib/api.functions";

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
  const navigate = useNavigate();
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
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const typeFromUrl = params.get("type");
    setActiveType(typeFromUrl);
    setSort({
      field: (params.get("sort") || initialSort.field) as SortField,
      order: (params.get("order") || initialSort.order) as SortOrder,
    });
    setSearchQuery(params.get("search") || initialSearchQuery);
  }, [initialSort.field, initialSort.order, initialSearchQuery]);

  // Navigation handlers
  const handleSearch = useCallback(
    (e: React.SyntheticEvent) => {
      e.preventDefault();
      void navigate({
        search: ((prev: any) => {
          const next = { ...prev };
          if (searchQuery.trim()) next.search = searchQuery.trim();
          else delete next.search;
          delete next.page;
          return next;
        }) as any,
      });
    },
    [searchQuery, navigate],
  );

  const handleSort = useCallback((field: SortField) => {
    void navigate({
      search: ((prev: any) => {
        const currentOrder = prev.order as string | undefined;
        const currentSort = prev.sort as string | undefined;
        const newOrder =
          currentSort === field && currentOrder === "asc" ? "desc" : "asc";
        return { ...prev, sort: field, order: newOrder };
      }) as any,
    });
  }, [navigate]);

  const handlePageChange = useCallback((newPage: number) => {
    void navigate({
      search: ((prev: any) => ({ ...prev, page: newPage })) as any,
    });
  }, [navigate]);

  const handleLimitChange = useCallback((newLimit: number) => {
    void navigate({
      search: ((prev: any) => {
        const next = { ...prev, limit: newLimit };
        delete next.page;
        return next;
      }) as any,
    });
  }, [navigate]);

  const handleEdit = useCallback((id: string) => {
    void navigate({ to: `/admin/discounts/${id}/edit` as string });
  }, [navigate]);

  const handleTypeFilter = useCallback((type: string | null) => {
    void navigate({
      search: ((prev: any) => {
        const next = { ...prev };
        if (type) next.type = type;
        else delete next.type;
        delete next.page;
        return next;
      }) as any,
    });
  }, [navigate]);

  // API action handlers
  const handleDelete = useCallback((id: string) => {
    setDeleteConfirmation(id);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmation) return;
    const idToDelete = deleteConfirmation;
    setDeleteConfirmation(null);

    try {
      await deleteDiscount({ data: { id: idToDelete } });
      toast.success("Discount moved to trash");
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== idToDelete));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error: unknown) {
      console.error("Error deleting discount:", error);
      toast.error(getServerFnError(error, "Failed to delete discount"));
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
      await deleteDiscountPermanent({ data: { id: idToDelete } });
      toast.success("Discount deleted permanently");
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== idToDelete));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error: unknown) {
      console.error("Error permanently deleting discount:", error);
      toast.error(getServerFnError(error, "Failed to delete discount permanently"));
    }
  }, [permanentDeleteConfirmation]);

  const handleRestore = useCallback(async (id: string) => {
    try {
      await restoreDiscount({ data: { id } });
      toast.success("Discount restored");
      setDisplayDiscounts((prev) => prev.filter((d) => d.id !== id));
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.ceil((prev.total - 1) / prev.limit),
      }));
    } catch (error: unknown) {
      console.error("Error restoring discount:", error);
      toast.error(getServerFnError(error, "Failed to restore discount"));
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

    const idsToProcess = Array.from(selectedDiscounts);
    setBulkActionConfirmation(null);

    try {
      if (bulkActionConfirmation === "restore") {
        await bulkRestoreDiscounts({ data: { discountIds: idsToProcess } });
      } else {
        await bulkDeleteDiscounts({ data: { discountIds: idsToProcess, permanent: showTrashed } });
      }

      const title = bulkActionConfirmation === "restore"
        ? "Discounts restored"
        : showTrashed
          ? "Discounts deleted permanently"
          : "Discounts moved to trash";
      toast.success(title, {
        description: `${idsToProcess.length} discounts processed.`,
      });

      setDisplayDiscounts((prev) =>
        prev.filter((d) => !idsToProcess.includes(d.id)),
      );
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - idsToProcess.length),
        totalPages: Math.ceil((prev.total - idsToProcess.length) / prev.limit),
      }));
      setSelectedDiscounts(new Set());
    } catch (error: unknown) {
      console.error("Error processing bulk discount action:", error);
      toast.error(getServerFnError(
        error,
        bulkActionConfirmation === "restore"
          ? "Failed to restore discounts"
          : "Failed to delete discounts",
      ));
    }
  }, [selectedDiscounts, showTrashed, bulkActionConfirmation]);

  const handleToggleStatus = useCallback(async (id: string, currentStatus: boolean) => {
    try {
      await toggleDiscountStatus({ data: { id, isActive: !currentStatus } });
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
      toast.error(getServerFnError(error, "Failed to update discount status"));
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

  // formatDate → shared formatDateShort (date-only format)

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
