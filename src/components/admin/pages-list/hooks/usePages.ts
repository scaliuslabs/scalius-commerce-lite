// src/components/admin/pages-list/hooks/usePages.ts
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { useDebounce } from "@/hooks/use-debounce";
import { unixToDate } from "@/lib/utils";
import type { PageItem, Pagination, SortField, SortOrder } from "../types";

export function usePages(showTrashed: boolean) {
  const [pages, setPages] = useState<PageItem[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const [sortField, setSortField] = useState<SortField>("updatedAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const fetchPages = useCallback(async () => {
    setIsLoading(true);
    const params = new URLSearchParams({
      page: String(pagination.page),
      limit: String(pagination.limit),
      trashed: String(showTrashed),
      search: debouncedSearchQuery,
      sort: sortField,
      order: sortOrder,
    });

    try {
      const response = await fetch(`/api/pages?${params.toString()}`);
      if (!response.ok) throw new Error("Failed to fetch pages");
      const data = await response.json();

      // Convert Unix timestamps to Date objects
      // API returns ISO strings but they're converted from Unix timestamps
      const formattedPages = data.pages.map((page: any) => {
        const parseDate = (val: any) => {
          if (!val) return null;
          // If it's an ISO string, parse it directly
          if (typeof val === "string" && val.includes("T")) {
            return new Date(val);
          }
          // Otherwise, treat as Unix timestamp
          return unixToDate(val);
        };

        return {
          ...page,
          createdAt: parseDate(page.createdAt) || new Date(),
          updatedAt: parseDate(page.updatedAt) || new Date(),
          deletedAt: parseDate(page.deletedAt),
          publishedAt: parseDate(page.publishedAt),
        };
      });

      setPages(formattedPages);
      setPagination(data.pagination);
    } catch (error) {
      toast.error("Failed to load pages.");
    } finally {
      setIsLoading(false);
    }
  }, [
    pagination.page,
    pagination.limit,
    showTrashed,
    debouncedSearchQuery,
    sortField,
    sortOrder,
  ]);

  useEffect(() => {
    fetchPages();
  }, [fetchPages]);

  const goToPage = (page: number) => {
    setPagination((prev) => ({ ...prev, page }));
  };

  const changePageSize = (newLimit: number) => {
    setPagination((prev) => ({ ...prev, limit: newLimit, page: 1 }));
  };

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  return {
    pages,
    pagination,
    isLoading,
    searchQuery,
    setSearchQuery,
    sortField,
    sortOrder,
    goToPage,
    changePageSize,
    handleSort,
    fetchPages,
  };
}
