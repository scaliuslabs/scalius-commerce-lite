// src/components/admin/collections-list/components/CollectionPagination.tsx
import { AdminListPagination } from "@/components/admin/shared/AdminListPagination";
import type { CollectionPaginationProps } from "../types";

export function CollectionPagination({
  pagination,
  onPageChange,
  onPageSizeChange,
}: CollectionPaginationProps) {
  return (
    <AdminListPagination
      pagination={pagination}
      itemLabel="collections"
      onPageChange={onPageChange}
      onLimitChange={onPageSizeChange}
      showFirstLast
    />
  );
}
