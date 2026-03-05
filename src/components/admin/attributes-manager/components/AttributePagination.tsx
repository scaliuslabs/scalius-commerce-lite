// src/components/admin/attributes-manager/components/AttributePagination.tsx
import { AdminListPagination } from "@/components/admin/shared/AdminListPagination";
import type { AttributePaginationProps } from "../types";

export function AttributePagination({
  pagination,
  onPageChange,
  onPageSizeChange,
}: AttributePaginationProps) {
  return (
    <AdminListPagination
      pagination={pagination}
      itemLabel="attributes"
      onPageChange={onPageChange}
      onLimitChange={onPageSizeChange}
      showFirstLast
    />
  );
}
