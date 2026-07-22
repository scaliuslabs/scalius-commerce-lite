import { lazy, Suspense, useState, useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { Row } from "@tanstack/react-table";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
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
import { CustomerMobileCard } from "~/components/admin/customer-list/CustomerMobileCard";
import type { CustomerListBuyer } from "~/components/admin/customer-list/customer-list-model";
import { usePermissions } from "~/contexts/PermissionContext";

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
  const { hasPermission } = usePermissions();
  const showTrashed = search.trashed;
  const canCreate = hasPermission(PERMISSIONS.CUSTOMERS_CREATE);
  const canEdit = hasPermission(PERMISSIONS.CUSTOMERS_EDIT);
  const canDelete = hasPermission(PERMISSIONS.CUSTOMERS_DELETE);
  const canViewHistory = hasPermission(PERMISSIONS.CUSTOMERS_VIEW_HISTORY);

  // Mutations
  const deleteMutation = useDeleteCustomer();
  const permanentDeleteMutation = usePermanentDeleteCustomer();
  const restoreMutation = useRestoreCustomer();
  const bulkDeleteMutation = useBulkDeleteCustomers();

  // Delete confirmation state
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [bulkDeleteRequested, setBulkDeleteRequested] = useState(false);

  const isActionLoading =
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    bulkDeleteMutation.isPending;

  const handleConfirmDelete = useCallback(() => {
    if (!deleteId || !canDelete) return;
    const id = deleteId;
    setDeleteId(null);
    if (showTrashed) {
      permanentDeleteMutation.mutate(id);
    } else {
      deleteMutation.mutate(id);
    }
  }, [deleteId, canDelete, showTrashed, deleteMutation, permanentDeleteMutation]);

  const isCustomerDeleteDialogOpen = !!deleteId || bulkDeleteRequested;

  // Column definitions
  const columns = useMemo(
    () =>
      getCustomerColumns({
        showTrashed,
        symbol,
        canSelect: canDelete,
        canViewHistory,
        canEdit,
        canDelete,
        onEdit: (id) =>
          void navigate({ to: "/admin/customers/$customerId/edit", params: { customerId: id } }),
        onDelete: (id) => setDeleteId(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => setDeleteId(id),
      }),
    [
      showTrashed,
      symbol,
      canDelete,
      canViewHistory,
      canEdit,
      navigate,
      restoreMutation,
    ],
  );

  // Data selector
  const dataSelector = useMemo(
    () => createDataSelector<CustomerListBuyer>("customers"),
    [],
  );

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
      enableRowSelection: (row) =>
        canDelete && (!showTrashed || row.original.totalOrders === 0),
    });

  const handleConfirmBulkDelete = useCallback(() => {
    if (!canDelete || selectedIds.length === 0) return;
    const customerIds = [...selectedIds];
    setBulkDeleteRequested(false);
    bulkDeleteMutation.mutate(
      { customerIds, permanent: showTrashed },
      { onSuccess: clearSelection },
    );
  }, [
    bulkDeleteMutation,
    canDelete,
    clearSelection,
    selectedIds,
    showTrashed,
  ]);

  const mobileCardRenderer = useCallback(
    (row: Row<CustomerListBuyer>) => {
      const customer = row.original;
      return (
        <CustomerMobileCard
          customer={customer}
          selected={row.getIsSelected()}
          showTrashed={showTrashed}
          symbol={symbol}
          canSelect={canDelete && (!showTrashed || customer.totalOrders === 0)}
          canViewHistory={canViewHistory}
          canEdit={canEdit}
          canDelete={canDelete}
          onSelectedChange={(selected) => row.toggleSelected(selected)}
          onEdit={() => void navigate({
            to: "/admin/customers/$customerId/edit",
            params: { customerId: customer.id },
          })}
          onArchive={() => setDeleteId(customer.id)}
          onRestore={() => restoreMutation.mutate(customer.id)}
          onPermanentDelete={() => setDeleteId(customer.id)}
        />
      );
    }, [
      showTrashed,
      symbol,
      canDelete,
      canViewHistory,
      canEdit,
      navigate,
      restoreMutation,
    ],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {showTrashed ? "Customer Trash" : "Customers"}
          </h1>
          <p className="text-muted-foreground">
            {showTrashed
              ? "Review and manage deleted customer records."
              : "Find every guest and account buyer in one directory."}
          </p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Link
            to="/admin/customers"
            search={((prev: Record<string, unknown>) => ({ ...prev, trashed: !showTrashed })) as never}
            className="flex-1 sm:flex-none"
          >
            <Button
              variant="outline"
              size="sm"
              className="h-11 w-full sm:h-9 sm:w-auto"
            >
              {showTrashed ? (
                <Users className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {showTrashed ? "View Active" : "View Trash"}
            </Button>
          </Link>
          {!showTrashed && canCreate && (
            <Link to="/admin/customers/new" className="flex-1 sm:flex-none">
              <Button size="sm" className="h-11 w-full sm:h-9 sm:w-auto">
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
        mobileCardRenderer={mobileCardRenderer}
        emptyState={{
          icon: Users,
          title: showTrashed ? "Trash is empty" : "No customers found",
          description: showTrashed
            ? "Deleted customer records will appear here."
            : "Guest and account buyers appear after checkout. You can also add one manually.",
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
            bulkActions={canDelete ? (
              <Button
                variant="outline"
                size="sm"
                className="h-11 border-destructive text-destructive hover:bg-destructive/10 sm:h-9"
                onClick={() => setBulkDeleteRequested(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {showTrashed ? "Delete permanently" : "Move to trash"} ({selectedIds.length})
              </Button>
            ) : undefined}
          />
        }
      />

      {isCustomerDeleteDialogOpen && (
        <Suspense fallback={null}>
          <CustomerDeleteDialog
            showTrashed={showTrashed}
            customerCount={bulkDeleteRequested ? selectedIds.length : 1}
            isOpen={isCustomerDeleteDialogOpen}
            isActionLoading={isActionLoading}
            onOpenChange={(open) => {
              if (!open) {
                setDeleteId(null);
                setBulkDeleteRequested(false);
              }
            }}
            onConfirm={bulkDeleteRequested ? handleConfirmBulkDelete : handleConfirmDelete}
          />
        </Suspense>
      )}
    </div>
  );
}
