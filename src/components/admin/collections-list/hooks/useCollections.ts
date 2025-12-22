// src/components/admin/collections-list/hooks/useCollections.ts
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type {
  CollectionItem,
  Pagination,
  SortField,
  SortOrder,
} from "../types";

export function useCollections(
  showTrashed: boolean,
  searchQuery: string,
  sortField: SortField,
  sortOrder: SortOrder,
) {
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchCollections = useCallback(async () => {
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
      const response = await fetch(`/api/collections?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch collections");
      const data = await response.json();
      setCollections(data.data || data.collections || []);
      if (data.pagination) {
        setPagination(data.pagination);
      }
    } catch (error) {
      toast.error("Failed to load collections.");
      console.error("Error fetching collections:", error);
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
    fetchCollections();
  }, [fetchCollections]);

  const goToPage = (page: number) => {
    setPagination((prev) => ({ ...prev, page }));
  };

  const changePageSize = (newLimit: number) => {
    setPagination((prev) => ({ ...prev, limit: newLimit, page: 1 }));
  };

  return {
    collections,
    setCollections,
    pagination,
    isLoading,
    fetchCollections,
    goToPage,
    changePageSize,
  };
}
