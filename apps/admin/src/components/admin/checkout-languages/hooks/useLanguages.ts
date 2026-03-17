import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";

// Local type replacing @scalius/database/schema import
export interface CheckoutLanguage {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  isDefault: boolean;
  languageData: string;
  fieldVisibility: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ManagerCheckoutLanguage
  extends Omit<CheckoutLanguage, "languageData" | "fieldVisibility"> {
  languageData?: Record<string, string>;
  fieldVisibility?: Record<string, boolean>;
}

export type SortField =
  | "name"
  | "code"
  | "isActive"
  | "isDefault"
  | "createdAt"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

export const defaultLanguageData: Record<string, string> = {
  pageTitle: "Cart & Checkout",
  checkoutSectionTitle: "Checkout Information",
  cartSectionTitle: "Shopping Cart",
  customerNameLabel: "Full Name",
  customerNamePlaceholder: "Enter your full name",
  customerPhoneLabel: "Phone Number",
  customerPhonePlaceholder: "01XXXXXXXXX",
  customerPhoneHelp: "Example: 01712345678",
  customerEmailLabel: "Email (Optional)",
  customerEmailPlaceholder: "Enter your email address",
  shippingAddressLabel: "Delivery Address",
  shippingAddressPlaceholder: "Enter your full delivery address",
  cityLabel: "City",
  zoneLabel: "Zone",
  areaLabel: "Area (Optional)",
  shippingMethodLabel: "Choose Delivery Option",
  orderNotesLabel: "Order Notes (Optional)",
  orderNotesPlaceholder: "Any special instructions for your order?",
  continueShoppingText: "Continue Shopping",
  subtotalText: "Subtotal",
  shippingText: "Shipping",
  discountText: "Discount",
  totalText: "Total",
  discountCodePlaceholder: "Discount code",
  applyDiscountText: "Apply",
  removeDiscountText: "Remove",
  placeOrderText: "Place Order",
  processingText: "Processing...",
  emptyCartText: "Your cart is empty",
  termsText: "By placing this order, you agree to our Terms of Service and Privacy Policy",
  processingOrderTitle: "Processing Your Order",
  processingOrderMessage: "Please wait while we process your order.",
  requiredFieldIndicator: "*",
};

export const defaultFieldVisibility: Record<string, boolean> = {
  showEmailField: true,
  showOrderNotesField: true,
  showAreaField: true,
};

interface PaginationState {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export function useLanguages() {
  const [languages, setLanguages] = useState<ManagerCheckoutLanguage[]>([]);
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
    field: "name",
    order: "asc",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [showTrashed, setShowTrashed] = useState(false);
  const initialLoadDone = useRef(false);

  const fetchLanguages = useCallback(
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
          `/api/v1/admin/settings/checkout-languages?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch checkout languages");
        const json = await response.json();
        const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;

        const parsedLanguages = (data.languages || []).map((lang: Record<string, unknown>) => ({
          ...lang,
          languageData:
            typeof lang.languageData === "string"
              ? JSON.parse(lang.languageData as string)
              : lang.languageData,
          fieldVisibility:
            typeof lang.fieldVisibility === "string"
              ? JSON.parse(lang.fieldVisibility as string)
              : lang.fieldVisibility,
        }));

        setLanguages(parsedLanguages);
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
      } catch (error) {
        console.error("Error fetching checkout languages:", error);
        toast.error("Could not load checkout languages.");
      } finally {
        setIsLoading(false);
      }
    },
    [pagination.page, pagination.limit, searchQuery, sort, showTrashed],
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    const pageFromUrl = parseInt(url.searchParams.get("page") || "1");
    const limitFromUrl = parseInt(url.searchParams.get("limit") || "10");
    const searchFromUrl = url.searchParams.get("search") || "";
    const sortFieldFromUrl = url.searchParams.get("sort") as SortField | null;
    const sortOrderFromUrl = url.searchParams.get("order") as SortOrder | null;
    const showTrashedFromUrl = url.searchParams.get("trashed") === "true";

    setSearchQuery(searchFromUrl);
    if (sortFieldFromUrl && sortOrderFromUrl) {
      setSort({ field: sortFieldFromUrl, order: sortOrderFromUrl });
    }
    setShowTrashed(showTrashedFromUrl);

    fetchLanguages(
      pageFromUrl,
      limitFromUrl,
      searchFromUrl,
      sortFieldFromUrl && sortOrderFromUrl
        ? { field: sortFieldFromUrl, order: sortOrderFromUrl }
        : { field: "name", order: "asc" },
      showTrashedFromUrl,
    );
    initialLoadDone.current = true;
  }, []);

  useEffect(() => {
    if (initialLoadDone.current) {
      fetchLanguages();
    }
  }, [fetchLanguages]);

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
      fetchLanguages(1, pagination.limit, searchQuery, sort, showTrashed);
    },
    [searchQuery, pagination.limit, sort, showTrashed, fetchLanguages],
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
      fetchLanguages(1, pagination.limit, searchQuery, newSort, showTrashed);
    },
    [sort, pagination.limit, searchQuery, showTrashed, fetchLanguages],
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
    fetchLanguages(1, pagination.limit, searchQuery, sort, newShowTrashed);
  }, [showTrashed, pagination.limit, searchQuery, sort, fetchLanguages]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchLanguages(1, pagination.limit, "", sort, showTrashed);
  }, [pagination.limit, sort, showTrashed, fetchLanguages]);

  const handleSetActive = async (id: string, isActive: boolean) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/checkout-languages/${id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        },
      );
      if (!response.ok) {
        const res = await response.json();
        throw new Error(res.error || "Failed to update active state");
      }
      toast.success("Language active state updated successfully.");
      fetchLanguages(pagination.page);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to update active state.";
      toast.error(msg);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleFormSubmit = async (
    formData: Partial<ManagerCheckoutLanguage>,
    editingLanguageId: string | null,
  ): Promise<boolean> => {
    setIsActionLoading(true);
    const url = editingLanguageId
      ? `/api/v1/admin/settings/checkout-languages/${editingLanguageId}`
      : "/api/v1/admin/settings/checkout-languages";
    const method = editingLanguageId ? "PUT" : "POST";

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
          (editingLanguageId ? "Failed to update" : "Failed to create") +
          " checkout language: " +
          (result.details ? JSON.stringify(result.details) : ""),
        );
      }
      toast.success(`Checkout language ${editingLanguageId ? "updated" : "created"} successfully.`);
      fetchLanguages(editingLanguageId ? pagination.page : 1);
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "An unexpected error occurred.";
      toast.error(msg);
      return false;
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleSoftDelete = async (language: ManagerCheckoutLanguage) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/checkout-languages/${language.id}`,
        { method: "PATCH" },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Failed to move to trash");
      }
      toast.success(`"${language.name}" moved to trash.`);
      fetchLanguages(pagination.page);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to move to trash.";
      toast.error(msg);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handlePermanentDelete = async (language: ManagerCheckoutLanguage) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/checkout-languages/${language.id}`,
        { method: "DELETE" },
      );
      if (response.status !== 204) {
        const result = await response.json().catch(() => ({
          error: "Failed to permanently delete after API call.",
        }));
        throw new Error(result.error || "Failed to permanently delete");
      }
      toast.success(`"${language.name}" permanently deleted.`);
      fetchLanguages(pagination.page);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to permanently delete.";
      toast.error(msg);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (language: ManagerCheckoutLanguage) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/settings/checkout-languages/${language.id}/restore`,
        { method: "POST" },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Failed to restore language");
      }
      toast.success(`"${language.name}" restored successfully.`);
      fetchLanguages(pagination.page);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to restore language.";
      toast.error(msg);
    } finally {
      setIsActionLoading(false);
    }
  };

  const hasActiveFilters = searchQuery.trim().length > 0;

  return {
    languages,
    pagination,
    searchQuery,
    setSearchQuery,
    sort,
    isLoading,
    isActionLoading,
    showTrashed,
    hasActiveFilters,
    handleSearch,
    handleSort,
    toggleTrash,
    clearFilters,
    handleSetActive,
    handleFormSubmit,
    handleSoftDelete,
    handlePermanentDelete,
    handleRestore,
    fetchLanguages,
  };
}
