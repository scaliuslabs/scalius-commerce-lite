import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef,
  type Table,
  type PaginationState,
  type SortingState,
  type VisibilityState,
  type RowSelectionState,
} from "@tanstack/react-table";
import { useQuery, keepPreviousData, type UseQueryOptions } from "@tanstack/react-query";

export interface ServerTablePagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const defaultPagination: ServerTablePagination = {
  total: 0,
  page: 1,
  limit: 20,
  totalPages: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQueryOptions = UseQueryOptions<any, any, any, any>;

export interface UseServerTableOptions<TData> {
  columns: ColumnDef<TData, unknown>[];
  queryOptions: AnyQueryOptions;
  dataSelector: (raw: unknown) => {
    data: TData[];
    pagination: ServerTablePagination;
  };
  // URL state — read from Route.useSearch(), writes via callbacks
  currentPage: number;
  currentLimit: number;
  currentSort?: string;
  currentOrder?: "asc" | "desc";
  onPaginationChange: (page: number, limit: number) => void;
  onSortingChange: (sort: string, order: "asc" | "desc") => void;
  // Options
  enableRowSelection?: boolean;
  enableSorting?: boolean;
  defaultPageSize?: number;
  initialColumnVisibility?: Record<string, boolean>;
}

export interface UseServerTableReturn<TData> {
  table: Table<TData>;
  rawData: unknown;
  isFetching: boolean;
  isLoading: boolean;
  pagination: ServerTablePagination;
  selectedRows: TData[];
  selectedIds: string[];
  clearSelection: () => void;
}

export function useServerTable<TData>({
  columns,
  queryOptions: qOpts,
  dataSelector,
  currentPage,
  currentLimit,
  currentSort,
  currentOrder,
  onPaginationChange,
  onSortingChange,
  enableRowSelection = true,
  enableSorting = true,
  defaultPageSize = 20,
  initialColumnVisibility = {},
}: UseServerTableOptions<TData>): UseServerTableReturn<TData> {
  // React Query with keepPreviousData — no flash on page/sort change
  const { data: rawData, isFetching, isLoading } = useQuery({
    ...qOpts,
    placeholderData: keepPreviousData,
  });

  // Extract typed data from API response
  const { data, pagination } = useMemo(() => {
    if (!rawData) return { data: [] as TData[], pagination: defaultPagination };
    return dataSelector(rawData);
  }, [rawData, dataSelector]);

  // Table state
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialColumnVisibility);

  // Map URL params to TanStack Table state
  const paginationState: PaginationState = {
    pageIndex: (currentPage || 1) - 1,
    pageSize: currentLimit || defaultPageSize,
  };

  const sortingState: SortingState = currentSort
    ? [{ id: currentSort, desc: currentOrder === "desc" }]
    : [];

  const table = useReactTable({
    data,
    columns,
    // Server-side modes
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    // State
    state: {
      pagination: paginationState,
      sorting: sortingState,
      rowSelection,
      columnVisibility,
    },
    // Page count from server
    pageCount: pagination.totalPages || -1,
    rowCount: pagination.total,
    // Handlers → URL params via callbacks
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(paginationState) : updater;
      onPaginationChange(next.pageIndex + 1, next.pageSize);
    },
    onSortingChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(sortingState) : updater;
      const col = next[0];
      if (col) {
        onSortingChange(col.id, col.desc ? "desc" : "asc");
      }
    },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    // Features
    enableRowSelection,
    enableSorting,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => (row as { id: string }).id,
  });

  // Derived
  const selectedRows = table
    .getFilteredSelectedRowModel()
    .rows.map((r) => r.original);
  const selectedIds = selectedRows.map((r) => (r as { id: string }).id);
  const clearSelection = () => setRowSelection({});

  return {
    table,
    rawData,
    isFetching,
    isLoading,
    pagination,
    selectedRows,
    selectedIds,
    clearSelection,
  };
}
