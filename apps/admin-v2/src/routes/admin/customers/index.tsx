import { useState, useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Users, UserPlus, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { createListSearchValidator, createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useCurrency } from "~/hooks/use-currency";
import { customersQueryOptions } from "~/lib/api-query-options/customers";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeleteCustomer,
  usePermanentDeleteCustomer,
  useRestoreCustomer,
  useBulkDeleteCustomers,
} from "~/lib/api-mutations/customers";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import { getCustomerColumns } from "~/components/admin/data-table/columns/customer-columns";
import type { Customer } from "~/types/api-responses";

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

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              {showTrashed
                ? "This action cannot be undone. Are you sure you want to permanently delete this customer?"
                : "Are you sure you want to move this customer to the trash? It can be restored later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed ? "Delete Permanently" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
