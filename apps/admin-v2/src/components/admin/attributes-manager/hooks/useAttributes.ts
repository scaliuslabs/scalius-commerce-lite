// src/components/admin/attributes-manager/hooks/useAttributes.ts
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Attribute, Pagination, SortField, SortOrder } from "../types";
import { attributesQueryOptions } from "~/lib/api.queries";

export function useAttributes(
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
    trashed: showTrashed,
    search: searchQuery || undefined,
    sort: sortField,
    order: sortOrder,
  };

  const { data, isLoading } = useQuery({
    ...attributesQueryOptions(params),
    select: (raw) => {
      const d = raw as { attributes?: Attribute[]; pagination?: Pagination };
      return {
        attributes: d.attributes || [],
        pagination: d.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 },
      };
    },
  });

  const attributes = data?.attributes || [];
  const pagination = data?.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 };

  // Expose setAttributes for optimistic updates in useAttributeActions
  const [optimisticOverrides, setOptimisticOverrides] = useState<Attribute[] | null>(null);

  const setAttributes = useCallback((updater: React.SetStateAction<Attribute[]>) => {
    setOptimisticOverrides((prev) => {
      const current = prev ?? attributes;
      return typeof updater === "function" ? updater(current) : updater;
    });
  }, [attributes]);

  const fetchAttributes = useCallback(() => {
    setOptimisticOverrides(null);
    queryClient.invalidateQueries({ queryKey: ["attributes"] });
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
    attributes: optimisticOverrides ?? attributes,
    setAttributes,
    pagination,
    isLoading,
    fetchAttributes,
    goToPage,
    changePageSize,
  };
}
