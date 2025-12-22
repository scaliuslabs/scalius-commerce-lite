// src/components/admin/attributes-manager/hooks/useAttributes.ts
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { Attribute, Pagination, SortField, SortOrder } from "../types";

export function useAttributes(
  showTrashed: boolean,
  searchQuery: string,
  sortField: SortField,
  sortOrder: SortOrder,
) {
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchAttributes = useCallback(async () => {
    setIsLoading(true);
    const params = new URLSearchParams({
      page: String(pagination.page),
      limit: String(pagination.limit),
      trashed: String(showTrashed),
      search: searchQuery,
      sort: sortField,
      order: sortOrder,
    });

    try {
      const response = await fetch(
        `/api/admin/attributes?${params.toString()}`,
      );
      if (!response.ok) throw new Error("Failed to fetch attributes");
      const data = await response.json();
      setAttributes(data.data);
      setPagination(data.pagination);
    } catch (error) {
      toast.error("Failed to load attributes.");
    } finally {
      setIsLoading(false);
    }
  }, [
    pagination.page,
    pagination.limit,
    showTrashed,
    searchQuery,
    sortField,
    sortOrder,
  ]);

  useEffect(() => {
    fetchAttributes();
  }, [fetchAttributes]);

  const goToPage = (page: number) => {
    setPagination((prev) => ({ ...prev, page }));
  };

  const changePageSize = (newLimit: number) => {
    setPagination((prev) => ({ ...prev, limit: newLimit, page: 1 }));
  };

  return {
    attributes,
    setAttributes,
    pagination,
    isLoading,
    fetchAttributes,
    goToPage,
    changePageSize,
  };
}
