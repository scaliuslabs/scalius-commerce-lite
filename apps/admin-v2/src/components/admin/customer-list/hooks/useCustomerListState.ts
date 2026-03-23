import { useState, useEffect, useCallback, useMemo, useRef } from "react";

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | string | number | null;
  cityName?: string | null;
  zoneName?: string | null;
  areaName?: string | null;
}

export interface CustomerListPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type SortField =
  | "name"
  | "totalOrders"
  | "totalSpent"
  | "lastOrderAt"
  | "createdAt"
  | "updatedAt";

export interface CustomerDialogState {
  action: "delete" | "bulk-delete";
  id?: string;
}

export function useCustomerListState(
  initialCustomers: Customer[],
  initialPagination: CustomerListPagination,
  initialSearchQuery: string,
  initialSort: { field: SortField; order: "asc" | "desc" },
) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [localSearch, setLocalSearch] = useState(initialSearchQuery);
  const [sort, setSort] = useState(initialSort);
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(
    new Set(),
  );
  const [dialogState, setDialogState] = useState<CustomerDialogState | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoadingCustomers, setIsLoadingCustomers] = useState(false);
  const searchTimeoutRef = useRef<number | undefined>(undefined);
  const prevSearchQueryRef = useRef(initialSearchQuery);

  const [displayCustomers, setDisplayCustomers] = useState<Customer[]>(
    initialCustomers || [],
  );
  const [currentPagination, setCurrentPagination] = useState(initialPagination);

  // Sync props
  useEffect(() => {
    setDisplayCustomers(initialCustomers || []);
  }, [initialCustomers]);

  useEffect(() => {
    setCurrentPagination(initialPagination);
  }, [initialPagination]);

  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  // Initialize from URL
  useEffect(() => {
    const url = new URL(window.location.href);
    setSort({
      field: (url.searchParams.get("sort") || initialSort.field) as SortField,
      order: (url.searchParams.get("order") || initialSort.order) as "asc" | "desc",
    });
    setSearchQuery(url.searchParams.get("search") || initialSearchQuery);
  }, [initialSort, initialSearchQuery]);

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
      if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        setLocalSearch("");
        searchInputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const toggleCustomerSelection = useCallback((id: string) => {
    setSelectedCustomers((prev) => {
      const newSelection = new Set(prev);
      if (newSelection.has(id)) {
        newSelection.delete(id);
      } else {
        newSelection.add(id);
      }
      return newSelection;
    });
  }, []);

  const toggleAllCustomers = useCallback(() => {
    if (
      selectedCustomers.size === displayCustomers.length &&
      displayCustomers.length > 0
    ) {
      setSelectedCustomers(new Set());
    } else {
      setSelectedCustomers(new Set(displayCustomers.map((c) => c.id)));
    }
  }, [displayCustomers, selectedCustomers.size]);

  const selectAllCheckedState = useMemo(
    () =>
      displayCustomers.length > 0 &&
      (selectedCustomers.size === displayCustomers.length
        ? true
        : selectedCustomers.size > 0
          ? ("indeterminate" as const)
          : false),
    [selectedCustomers.size, displayCustomers.length],
  );

  return {
    searchInputRef,
    searchQuery,
    setSearchQuery,
    localSearch,
    setLocalSearch,
    sort,
    setSort,
    selectedCustomers,
    setSelectedCustomers,
    dialogState,
    setDialogState,
    isProcessing,
    setIsProcessing,
    isLoadingCustomers,
    setIsLoadingCustomers,
    searchTimeoutRef,
    prevSearchQueryRef,
    displayCustomers,
    setDisplayCustomers,
    currentPagination,
    setCurrentPagination,
    toggleCustomerSelection,
    toggleAllCustomers,
    selectAllCheckedState,
  };
}
