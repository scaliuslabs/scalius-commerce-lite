// src/components/admin/pages-list/components/PagePagination.tsx
import { AdminListPagination } from "@/components/admin/shared/AdminListPagination";
import type { Pagination } from "../types";

interface PagePaginationProps {
  pagination: Pagination;
  goToPage: (page: number) => void;
  changePageSize: (limit: number) => void;
}

export function PagePagination({
  pagination,
  goToPage,
  changePageSize,
}: PagePaginationProps) {
  return (
    <AdminListPagination
      pagination={pagination}
      itemLabel="pages"
      onPageChange={goToPage}
      onLimitChange={changePageSize}
    />
  );
}
