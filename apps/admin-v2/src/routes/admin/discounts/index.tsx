import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Plus, Trash2, Tag } from "lucide-react";
import {
  createListSearchValidator,
  createDataSelector,
  normalizeOptionalSearchString,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { useCurrency } from "~/hooks/use-currency";
import {
  useDeleteDiscount,
  usePermanentDeleteDiscount,
  useRestoreDiscount,
  useToggleDiscountStatus,
  useBulkDeleteDiscounts,
} from "~/lib/api-mutations/discounts";
import {
  DataTable,
  useServerTable,
} from "~/components/admin/data-table";
import { DiscountTableToolbar } from "~/components/admin/data-table/DiscountTableToolbar";
import {
  getDiscountColumns,
  type DiscountItem,
} from "~/components/admin/data-table/columns/discount-columns";

const baseSearchValidator = createListSearchValidator(
  ["code", "type", "value", "startDate", "endDate", "createdAt", "updatedAt"] as const,
  { limit: 10, sort: "updatedAt" },
);

type DiscountSort =
  | "code"
  | "type"
  | "value"
  | "startDate"
  | "endDate"
  | "createdAt"
  | "updatedAt";

type SearchParams = ListSearchParams<DiscountSort> & {
  type?: string;
};

function validateDiscountSearch(search: SearchValidatorInput<SearchParams>): SearchParams {
  return {
    ...baseSearchValidator(search),
    type: normalizeOptionalSearchString(search.type),
  };
}

function mapParams(deps: SearchParams) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
    type: deps.type,
  };
}

export const Route = createFileRoute("/admin/discounts/")({
  validateSearch: validateDiscountSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, discountsQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Deleted Discounts" : "Discounts"} | Scalius Admin`,
      },
    ],
  }),
  component: DiscountsPage,
  errorComponent: RouteErrorComponent,
});

function DiscountsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { symbol } = useCurrency();
  const showTrashed = search.trashed;

  // Mutations
  const deleteMutation = useDeleteDiscount();
  const permanentDeleteMutation = usePermanentDeleteDiscount();
  const restoreMutation = useRestoreDiscount();
  const toggleStatusMutation = useToggleDiscountStatus();
  const bulkDeleteMutation = useBulkDeleteDiscounts();

  // Column action callbacks
  const handleEdit = useCallback(
    (id: string) => {
      void navigate({ to: "/admin/discounts/$discountId/edit", params: { discountId: id } });
    },
    [navigate],
  );

  const handleDuplicate = useCallback(
    (id: string) => {
      void navigate({
        to: "/admin/discounts/$discountId/edit",
        params: { discountId: id },
        search: { duplicate: true } as Record<string, unknown>,
      });
    },
    [navigate],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate(id);
    },
    [deleteMutation],
  );

  const handleRestore = useCallback(
    (id: string) => {
      restoreMutation.mutate(id);
    },
    [restoreMutation],
  );

  const handlePermanentDelete = useCallback(
    (id: string) => {
      permanentDeleteMutation.mutate(id);
    },
    [permanentDeleteMutation],
  );

  const handleToggleStatus = useCallback(
    (id: string, currentStatus: boolean) => {
      toggleStatusMutation.mutate({ id, isActive: !currentStatus });
    },
    [toggleStatusMutation],
  );

  // Columns
  const columns = useMemo(
    () =>
      getDiscountColumns({
        showTrashed,
        symbol,
        onEdit: handleEdit,
        onDuplicate: handleDuplicate,
        onDelete: handleDelete,
        onRestore: handleRestore,
        onPermanentDelete: handlePermanentDelete,
        onToggleStatus: handleToggleStatus,
      }),
    [
      showTrashed,
      symbol,
      handleEdit,
      handleDuplicate,
      handleDelete,
      handleRestore,
      handlePermanentDelete,
      handleToggleStatus,
    ],
  );

  // Data selector
  const dataSelector = useMemo(() => createDataSelector<DiscountItem>("discounts"), []);

  // URL param updaters
  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          page,
          limit,
        })) as never,
      });
    },
    [navigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          sort,
          order,
          page: 1,
        })) as never,
      });
    },
    [navigate],
  );

  const onSearchChange = useCallback(
    (value: string) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          search: value || undefined,
          page: 1,
        })) as never,
      });
    },
    [navigate],
  );

  const onTypeFilterChange = useCallback(
    (type: string | null) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, page: 1 };
          if (type) {
            next.type = type;
          } else {
            delete next.type;
          }
          return next;
        }) as never,
      });
    },
    [navigate],
  );

  // Server table
  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable<DiscountItem>({
      columns,
      queryOptions: discountsQueryOptions(mapParams(search)),
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange,
      onSortingChange,
    });

  // Bulk action handlers
  const handleBulkDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    bulkDeleteMutation.mutate(
      { discountIds: selectedIds, permanent: showTrashed },
      { onSuccess: clearSelection },
    );
  }, [selectedIds, showTrashed, bulkDeleteMutation, clearSelection]);

  // Toolbar
  const toolbar = (
    <DiscountTableToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      selectedCount={selectedIds.length}
      activeType={search.type || null}
      onTypeFilterChange={onTypeFilterChange}
      bulkActions={
        <Button
          variant={showTrashed ? "destructive" : "outline"}
          size="sm"
          onClick={handleBulkDelete}
          className={
            !showTrashed
              ? "text-destructive border-destructive hover:bg-destructive/10"
              : undefined
          }
        >
          <Trash2 className="h-4 w-4 mr-1.5" />
          {showTrashed
            ? `Delete (${selectedIds.length})`
            : `Trash (${selectedIds.length})`}
        </Button>
      }
      actions={
        <div className="flex items-center gap-2">
          <Link
            to="/admin/discounts"
            search={showTrashed ? {} : { trashed: true }}
          >
            <Button variant="outline" size="sm">
              {showTrashed ? (
                <>
                  <Tag className="mr-2 h-4 w-4" />
                  View Active
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  View Trash
                </>
              )}
            </Button>
          </Link>
          {!showTrashed && (
            <Button
              onClick={() =>
                void navigate({ to: "/admin/discounts/new" })
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Discount
            </Button>
          )}
        </div>
      }
    />
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {showTrashed ? "Deleted Discounts" : "Discounts"}
        </h1>
        <p className="text-muted-foreground">
          {showTrashed
            ? "View and manage deleted discounts"
            : "Manage your discounts and promotional codes"}
        </p>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        toolbar={toolbar}
        itemLabel="discounts"
        emptyState={{
          icon: Tag,
          title:
            search.search || search.type
              ? "No discounts match your criteria."
              : showTrashed
                ? "Trash is empty."
                : "No discounts created yet.",
          description:
            search.search || search.type
              ? "Try adjusting your search or filters."
              : showTrashed
                ? "Deleted discounts will appear here."
                : "Create your first discount to get started.",
          action:
            !showTrashed && !search.search ? (
              <Button
                onClick={() =>
                  void navigate({ to: "/admin/discounts/new" })
                }
              >
                <Plus className="h-4 w-4 mr-2" />
                Create First Discount
              </Button>
            ) : undefined,
        }}
      />
    </div>
  );
}
