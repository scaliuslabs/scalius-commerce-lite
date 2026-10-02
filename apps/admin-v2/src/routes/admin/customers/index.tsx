import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import {
  deleteApiV1AdminCustomersById,
  deleteApiV1AdminCustomersByIdPermanent,
  postApiV1AdminCustomersBulkDelete,
  postApiV1AdminCustomersByIdRestore,
} from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { customerTitle } from "~/lib/customer-title";
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { customersQueryOptions, type CustomersListPayload } from "~/lib/api-query-options/customers";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage } from "~/components/admin/resource/ResourceListPage";
import { DateText, sortHeader } from "~/components/admin/resource/columns";
import { CustomerBulkActions } from "~/components/admin/customers/CustomerBulkActions";
import { CustomerListFilters } from "~/components/admin/customers/CustomerListFilters";
import { ExportCustomersDialog } from "~/components/admin/customers/ExportCustomersDialog";
import {
  CUSTOMER_FILTER_PARAMS,
  customerListFilters,
  validateCustomerSearch,
  type CustomerListSearch,
} from "~/components/admin/customers/customer-list-search";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { CustomerCell } from "~/components/admin/CustomerCell";
import { pageHead } from "~/i18n/page-titles";

type Customer = CustomersListPayload["customers"][number];

/** The list's own search key per tab ("customers", "customers.subscribers", "customers.trash"). */
const searchKey = (search: CustomerListSearch) => listSearchKey("customers", search, "view");

function listQuery(search: CustomerListSearch, term: string) {
  return customersQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    ...customerListFilters(search),
  });
}

export const Route = createFileRoute("/admin/customers/")({
  validateSearch: validateCustomerSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(searchKey(deps), deps.q))),
  head: () => pageHead("customers"),
  component: CustomersPage,
  errorComponent: RouteErrorComponent,
});

// Customers tied to orders keep their record: only order-free ones can be deleted for good.
const deletable = (row: Customer) => row.totalOrders === 0;

async function runEach(rows: Customer[], call: (id: string) => Promise<unknown>) {
  for (const row of rows) await call(row.id);
}

function CustomersPage() {
  const search = Route.useSearch();
  const [term] = useListSearch(searchKey(search));
  const t = useMessages(customersMessages);
  const { fmt } = useCurrency();
  const { hasPermission } = usePermissions();
  const canDelete = hasPermission(PERMISSIONS.CUSTOMERS_DELETE);
  const canEdit = hasPermission(PERMISSIONS.CUSTOMERS_EDIT);
  const openTo = (row: Customer) => `/admin/customers/${row.id}/edit`;
  // The export dialog: from the header (the filters) or the bulk bar (the selection).
  const [exporting, setExporting] = useState<{ open: boolean; ids: string[] }>({ open: false, ids: [] });
  // Same query as the table (shared cache): the export dialog names how many match.
  const { data: listed } = useQuery(listQuery(search, term));

  const columns = useMemo<ColumnDef<Customer, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("customer")),
      meta: { mobile: "primary", minWidth: 200 },
      cell: ({ row }) => <CustomerCell customer={row.original} to={search.trashed ? undefined : openTo(row.original)} />,
    },
    {
      accessorKey: "totalOrders",
      header: sortHeader(t("orders")),
      meta: { mobile: "secondary", numeric: true, priority: 60, minWidth: 100 },
      cell: ({ row }) => {
        const count = row.original.totalOrders;
        return <span className="text-muted-foreground">{count === 1 ? t("orderCountOne") : t("orderCount", { count })}</span>;
      },
    },
    {
      accessorKey: "totalSpent",
      header: sortHeader(t("spent")),
      meta: { mobile: "secondary", numeric: true, priority: 80, minWidth: 110 },
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.totalSpent)}</span>,
    },
    {
      accessorKey: "lastOrderAt",
      header: sortHeader(t("lastOrder")),
      meta: { priority: 40, minWidth: 120 },
      cell: ({ row }) => <DateText value={row.original.lastOrderAt} />,
    },
  ], [t, fmt, search.trashed]);

  return (
    <>
      <ResourceListPage<Customer>
        title={t("customers")}
        actions={
          <>
            <Button variant="outline" onClick={() => setExporting({ open: true, ids: [] })}>{t("export")}</Button>
            {hasPermission(PERMISSIONS.CUSTOMERS_CREATE) ? <Button asChild><Link to="/admin/customers/new">{t("addCustomer")}</Link></Button> : null}
          </>
        }
        search={search}
        list="customers"
        appActions="customer"
        query={listQuery(search, term)}
        pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
        dataKey="customers"
        columns={columns}
        invalidate={[queryKeys.customers.all, queryKeys.dashboard.all]}
        empty={{ icon: UserRound, title: t("emptyTitle"), description: t("emptyBody") }}
        views={{ param: "view", tabs: [{ value: "subscribers", label: t("subscribers") }] }}
        searchPlaceholder={t("searchPlaceholder")}
        countLabel={(count) => (count === 1 ? t("customersCountOne") : t("customersCount", { count }))}
        filterParams={CUSTOMER_FILTER_PARAMS}
        filters={<CustomerListFilters search={search} />}
        bulkActions={(rows, done) => (
          <CustomerBulkActions
            rows={rows}
            done={done}
            canEdit={canEdit}
            onExport={() => setExporting({ open: true, ids: rows.map((row) => row.id) })}
          />
        )}
        rowTo={openTo}
        rowLabel={(row) => customerTitle(row, t).title}
        canSelectRow={search.trashed ? deletable : undefined}
        lifecycle={{
          canTrash: canDelete,
          canRestore: canDelete,
          canDelete,
          canDeleteRow: deletable,
          undoTrash: true,
          run: (action, rows) => {
            const customerIds = rows.map((row) => row.id);
            if (action === "restore") return runEach(rows, (id) => apiData(postApiV1AdminCustomersByIdRestore({ path: { id } })));
            if (rows.length > 1) return apiData(postApiV1AdminCustomersBulkDelete({ body: { customerIds, permanent: action === "delete" } }));
            return action === "delete"
              ? apiData(deleteApiV1AdminCustomersByIdPermanent({ path: { id: customerIds[0]! } }))
              : apiData(deleteApiV1AdminCustomersById({ path: { id: customerIds[0]! } }));
          },
        }}
      />
      <ExportCustomersDialog
        open={exporting.open}
        onOpenChange={(open) => setExporting((current) => ({ ...current, open }))}
        filters={customerListFilters(search)}
        selectedIds={exporting.ids}
        total={term ? null : listed?.pagination.total ?? null}
        searchActive={Boolean(term)}
      />
    </>
  );
}
