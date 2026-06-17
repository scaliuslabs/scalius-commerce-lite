import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { checkoutLanguagesQueryOptions } from "~/lib/api-query-options/checkout-languages";
import {
  useCreateCheckoutLanguage,
  useUpdateCheckoutLanguage,
  useSoftDeleteCheckoutLanguage,
  useDeleteCheckoutLanguage,
  useRestoreCheckoutLanguage,
} from "~/lib/api-mutations/checkout-languages";
import {
  type CheckoutLanguage,
  type CheckoutLanguagesPagination,
  type CheckoutLanguagesQueryInput,
  type CheckoutLanguageWriteInput,
} from "@/lib/api-functions/checkout-languages";

export type { CheckoutLanguage };

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
  customerPhonePlaceholder: "Phone number",
  customerPhoneHelp: "Enter your phone number with country code",
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

const DEFAULT_PAGINATION: CheckoutLanguagesPagination = {
  total: 0,
  page: 1,
  limit: 10,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false,
};

const EMPTY_CHECKOUT_LANGUAGES: CheckoutLanguage[] = [];

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseObject(parsed);
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toStringRecord(
  value: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  const parsed = parseObject(value);
  if (!parsed) return { ...fallback };
  const result = { ...fallback };
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue === "string") result[key] = rawValue;
    else if (typeof rawValue === "number" || typeof rawValue === "boolean")
      result[key] = String(rawValue);
  }
  return result;
}

function toBooleanRecord(
  value: unknown,
  fallback: Record<string, boolean>,
): Record<string, boolean> {
  const parsed = parseObject(value);
  if (!parsed) return { ...fallback };
  const result = { ...fallback };
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue === "boolean") result[key] = rawValue;
    else if (rawValue === "true") result[key] = true;
    else if (rawValue === "false") result[key] = false;
    else if (typeof rawValue === "number") result[key] = rawValue !== 0;
  }
  return result;
}

export function useLanguages() {
  const queryClient = useQueryClient();

  // Local filter/sort/pagination state (sub-tab component, no URL params)
  const [page, setPage] = useState(1);
  const [limit] = useState(10);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "name",
    order: "asc",
  });
  const [showTrashed, setShowTrashed] = useState(false);

  // Build query params
  const queryParams = useMemo(() => {
    const params: CheckoutLanguagesQueryInput = {
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
    ...checkoutLanguagesQueryOptions(queryParams),
    placeholderData: (prev) => prev, // keepPreviousData equivalent
  });

  // Parse response
  const languages = useMemo<ManagerCheckoutLanguage[]>(() => {
    const rawLanguages = data?.languages ?? EMPTY_CHECKOUT_LANGUAGES;
    return rawLanguages.map((lang) => ({
      ...lang,
      languageData: toStringRecord(lang.languageData, defaultLanguageData),
      fieldVisibility: toBooleanRecord(
        lang.fieldVisibility,
        defaultFieldVisibility,
      ),
    }));
  }, [data?.languages]);

  const pagination = data?.pagination ?? DEFAULT_PAGINATION;

  // Mutations
  const createMutation = useCreateCheckoutLanguage();
  const updateMutation = useUpdateCheckoutLanguage();
  const softDeleteMutation = useSoftDeleteCheckoutLanguage();
  const deleteMutation = useDeleteCheckoutLanguage();
  const restoreMutation = useRestoreCheckoutLanguage();

  const isActionLoading =
    createMutation.isPending ||
    updateMutation.isPending ||
    softDeleteMutation.isPending ||
    deleteMutation.isPending ||
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

  const toggleTrash = useCallback(() => {
    setShowTrashed((prev) => !prev);
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setAppliedSearch("");
    setPage(1);
  }, []);

  const handleSetActive = useCallback(
    async (id: string, isActive: boolean) => {
      await updateMutation.mutateAsync({ id, update: { isActive } });
    },
    [updateMutation],
  );

  const handleFormSubmit = useCallback(
    async (
      formData: Partial<ManagerCheckoutLanguage>,
      editingLanguageId: string | null,
    ): Promise<boolean> => {
      try {
        if (editingLanguageId) {
          await updateMutation.mutateAsync({
            id: editingLanguageId,
            update: formData as CheckoutLanguageWriteInput,
          });
        } else {
          await createMutation.mutateAsync(
            formData as CheckoutLanguageWriteInput,
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

  const handleSoftDelete = useCallback(
    async (language: ManagerCheckoutLanguage) => {
      await softDeleteMutation.mutateAsync({ id: language.id });
    },
    [softDeleteMutation],
  );

  const handlePermanentDelete = useCallback(
    async (language: ManagerCheckoutLanguage) => {
      await deleteMutation.mutateAsync({ id: language.id });
    },
    [deleteMutation],
  );

  const handleRestore = useCallback(
    async (language: ManagerCheckoutLanguage) => {
      await restoreMutation.mutateAsync({ id: language.id });
    },
    [restoreMutation],
  );

  const fetchLanguages = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["settings", "checkout-languages"],
    });
  }, [queryClient]);

  const hasActiveFilters = searchQuery.trim().length > 0;

  return {
    languages,
    pagination,
    searchQuery,
    setSearchQuery,
    sort,
    isLoading: isLoading || isFetching,
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
