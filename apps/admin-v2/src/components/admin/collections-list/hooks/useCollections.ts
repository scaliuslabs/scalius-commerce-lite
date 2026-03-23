// src/components/admin/collections-list/hooks/useCollections.ts
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CollectionItem,
  Pagination,
  SortField,
  SortOrder,
} from "../types";
import { collectionsQueryOptions } from "~/lib/api.queries";

export function useCollections(
  showTrashed: boolean,
  searchQuery: string,
  sortField: SortField,
  sortOrder: SortOrder,
) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const params = {
    page,
    limit,
    showTrashed,
    search: searchQuery || undefined,
    sort: sortField,
    order: sortOrder,
  };

  const { data, isLoading } = useQuery({
    ...collectionsQueryOptions(params),
    select: (raw) => {
      const d = raw as { collections?: CollectionItem[]; pagination?: Pagination };
      return {
        collections: d.collections || [],
        pagination: d.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 },
      };
    },
  });

  const collections = data?.collections || [];
  const pagination = data?.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 };

  // Expose setCollections for optimistic updates in useCollectionActions
  const [optimisticOverrides, setOptimisticOverrides] = useState<CollectionItem[] | null>(null);

  const setCollections = useCallback((updater: React.SetStateAction<CollectionItem[]>) => {
    setOptimisticOverrides((prev) => {
      const current = prev ?? collections;
      return typeof updater === "function" ? updater(current) : updater;
    });
  }, [collections]);

  const fetchCollections = useCallback(() => {
    setOptimisticOverrides(null);
    queryClient.invalidateQueries({ queryKey: ["collections"] });
  }, [queryClient]);

  const goToPage = (newPage: number) => {
    setOptimisticOverrides(null);
    setPage(newPage);
  };

  const changePageSize = (newLimit: number) => {
    setOptimisticOverrides(null);
    setLimit(newLimit);
    setPage(1);
  };

  return {
    collections: optimisticOverrides ?? collections,
    setCollections,
    pagination,
    isLoading,
    fetchCollections,
    goToPage,
    changePageSize,
  };
}
