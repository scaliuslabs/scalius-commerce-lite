import { lazy, Suspense, useState, useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Users, UserPlus, Trash2 } from "lucide-react";
import { createListSearchValidator, createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { Button } from "~/components/ui/button";
import { useCurrency } from "~/hooks/use-currency";
import { customersQueryOptions } from "~/lib/api-query-options/customers";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeleteCustomer,
  usePermanentDeleteCustomer,
  useRestoreCustomer,
  useBulkDeleteCustomers,
} from "~/lib/api-mutations/customers";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { getCustomerColumns } from "~/components/admin/data-table/columns/customer-columns";
import type { Customer } from "~/types/api-responses";

const CustomerDeleteDialog = lazy(() =>
  import("./-CustomerDeleteDialog").then((module) => ({
    default: module.CustomerDeleteDialog,
  })),
);

const validateCustomerSearch = createListSearchValidator(
  ["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"] as const,
  { limit: 10, sort: "updatedAt" },
);

function mapParams(deps: ReturnType<typeof validateCustomerSearch>) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
  };
}

export const Route = createFileRoute("/admin/customers/")({
  validateSearch: validateCustomerSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, customersQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Trash" : "Customers"} | Scalius Admin`,
      },
    ],
  }),
  component: CustomersPage,
  errorComponent: RouteErrorComponent,
});

function CustomersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { symbol } = useCurrency();
  const showTrashed = search.trashed;

  // Mutations
  const deleteMutation = useDeleteCustomer();
  const permanentDeleteMutation = usePermanentDeleteCustomer();
  const restoreMutation = useRestoreCustomer();
  const bulkDeleteMutation = useBulkDeleteCustomers();

  // Delete confirmation state
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const isActionLoading =
    deleteMutation.isPending || permanentDeleteMutation.isPending;

  const handleConfirmDelete = useCallback(() => {
    if (!deleteId) return;
    const id = deleteId;
    setDeleteId(null);
    if (showTrashed) {
      permanentDeleteMutation.mutate(id);
    } else {
      deleteMutation.mutate(id);
    }
  }, [deleteId, showTrashed, deleteMutation, permanentDeleteMutation]);

  const isCustomerDeleteDialogOpen = !!deleteId;

  // Column definitions
  const columns = useMemo(
    () =>
      getCustomerColumns({
        showTrashed,
        symbol,
        onEdit: (id) =>
          void navigate({ to: "/admin/customers/$customerId/edit", params: { customerId: id } }),
        onDelete: (id) => setDeleteId(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => setDeleteId(id),
      }),
    [showTrashed, symbol, navigate, restoreMutation],
  );

  // Data selector
  const dataSelector = useMemo(() => createDataSelector<Customer>("customers"), []);

  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
      });
    },
    [navigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({ ...prev, sort, order, page: 1 })) as never,
      });
    },
    [navigate],
  );

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: customersQueryOptions(mapParams(search)),
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange,
      onSortingChange,
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {showTrashed ? "Customer Trash" : "Customers"}
          </h1>
          <p className="text-muted-foreground">
            {showTrashed
              ? "Review and manage deleted customer records."
              : "Browse, manage, and view your customer database."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/customers"
            search={((prev: Record<string, unknown>) => ({ ...prev, trashed: !showTrashed })) as never}
          >
            <Button variant="outline" size="sm">
              {showTrashed ? (
                <Users className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {showTrashed ? "View Active" : "View Trash"}
            </Button>
          </Link>
          {!showTrashed && (
            <Link to="/admin/customers/new">
              <Button size="sm">
                <UserPlus className="mr-2 h-4 w-4" />
                Add Customer
              </Button>
            </Link>
          )}
        </div>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        itemLabel="customers"
        emptyState={{
          icon: Users,
          title: showTrashed ? "Trash is empty" : "No customers found",
          description: showTrashed
            ? "Deleted customer records will appear here."
            : "Add a new customer or sync from your orders.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search by name, phone, or email..."
            selectedCount={selectedIds.length}
            bulkActions={
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => {
                  bulkDeleteMutation.mutate(
                    {
                      customerIds: selectedIds,
                      permanent: showTrashed,
                    },
                    { onSuccess: clearSelection },
                  );
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {showTrashed ? "Delete" : "Trash"} ({selectedIds.length})
              </Button>
            }
          />
        }
      />

      {isCustomerDeleteDialogOpen && (
        <Suspense fallback={null}>
          <CustomerDeleteDialog
            showTrashed={showTrashed}
            isOpen={isCustomerDeleteDialogOpen}
            isActionLoading={isActionLoading}
            onOpenChange={(open) => !open && setDeleteId(null)}
            onConfirm={handleConfirmDelete}
          />
        </Suspense>
      )}
    </div>
  );
}
