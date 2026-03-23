import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Users, UserPlus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useCurrency } from "~/hooks/use-currency";
import { customersQueryOptions } from "~/lib/api.queries";
import {
  useDeleteCustomer,
  usePermanentDeleteCustomer,
  useRestoreCustomer,
  useBulkDeleteCustomers,
} from "~/lib/api.mutations";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import { getCustomerColumns } from "~/components/admin/data-table/columns/customer-columns";
import type { Customer } from "~/types/api-responses";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(10).catch(10),
  search: z.string().default("").catch(""),
  sort: z
    .enum([
      "name",
      "totalOrders",
      "totalSpent",
      "lastOrderAt",
      "createdAt",
      "updatedAt",
    ])
    .default("updatedAt")
    .catch("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc").catch("desc"),
  trashed: z.boolean().default(false).catch(false),
});

function mapParams(deps: z.infer<typeof searchSchema>) {
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
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(customersQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Trash" : "Customers"} | Scalius Admin`,
      },
    ],
  }),
  component: CustomersPage,
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

  // Column definitions
  const columns = useMemo(
    () =>
      getCustomerColumns({
        showTrashed,
        symbol,
        onEdit: (id) =>
          void navigate({ to: `/admin/customers/${id}/edit` as string }),
        onDelete: (id) => deleteMutation.mutate(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => permanentDeleteMutation.mutate(id),
      }),
    [showTrashed, symbol, navigate, deleteMutation, restoreMutation, permanentDeleteMutation],
  );

  // Data selector
  const dataSelector = useCallback(
    (raw: unknown) => {
      const r = raw as Record<string, unknown>;
      return {
        data: (r.customers ?? []) as Customer[],
        pagination: (r.pagination ?? {
          total: 0,
          page: search.page,
          limit: search.limit,
          totalPages: 0,
        }) as {
          total: number;
          page: number;
          limit: number;
          totalPages: number;
        },
      };
    },
    [search.page, search.limit],
  );

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryOptions: customersQueryOptions(mapParams(search)) as any,
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange: (page, limit) =>
        void navigate({
          search: ((p: any) => ({ ...p, page, limit })) as any,
        }),
      onSortingChange: (sort, order) =>
        void navigate({
          search: ((p: any) => ({ ...p, sort, order, page: 1 })) as any,
        }),
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
            search={(prev: any) => ({ ...prev, trashed: !showTrashed })}
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
                search: ((p: any) => ({ ...p, search: value, page: 1 })) as any,
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
    </div>
  );
}
