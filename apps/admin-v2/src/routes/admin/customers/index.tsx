import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { UserRound } from "lucide-react";
import {
  deleteApiV1AdminCustomersById,
  deleteApiV1AdminCustomersByIdPermanent,
  postApiV1AdminCustomersBulkDelete,
  postApiV1AdminCustomersByIdRestore,
} from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { createListSearchValidator } from "~/lib/list-helpers";
import { readListSearch, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { customersQueryOptions, type CustomersListPayload } from "~/lib/api-query-options/customers";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { DateText, sortHeader } from "~/components/admin/resource/columns";
import { translate, useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";

type Customer = CustomersListPayload["customers"][number];

const validateCustomerSearch = createListSearchValidator(
  ["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"] as const,
  { sort: "updatedAt", limit: 20 },
);

function listQuery(search: ReturnType<typeof validateCustomerSearch>, term: string) {
  return customersQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
  });
}

export const Route = createFileRoute("/admin/customers/")({
  validateSearch: validateCustomerSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, readListSearch("customers"))),
  head: () => ({ meta: [{ title: translate(customersMessages, "customers") }] }),
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
  const [term] = useListSearch("customers");
  const t = useMessages(customersMessages);
  const { fmt } = useCurrency();
  const { hasPermission } = usePermissions();
  const canDelete = hasPermission(PERMISSIONS.CUSTOMERS_DELETE);
  const openTo = (row: Customer) => `/admin/customers/${row.id}/edit`;

  const columns = useMemo<ColumnDef<Customer, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("customer")),
      meta: { mobile: "primary", minWidth: 200 },
      cell: ({ row }) => (
        <div className="min-w-0">
          <ResourceRowLink to={search.trashed ? undefined : openTo(row.original)}>{row.original.name || t("unnamed")}</ResourceRowLink>
          <span className="block truncate whitespace-nowrap font-mono text-muted-foreground">{formatPhoneForDisplay(row.original.phone)}</span>
        </div>
      ),
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
    <ResourceListPage<Customer>
      title={t("customers")}
      actions={hasPermission(PERMISSIONS.CUSTOMERS_CREATE) ? <Button asChild><Link to="/admin/customers/new">{t("addCustomer")}</Link></Button> : null}
      search={search}
      list="customers"
      query={listQuery(search, term)}
      pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
      dataKey="customers"
      columns={columns}
      invalidate={[queryKeys.customers.all, queryKeys.dashboard.all]}
      empty={{ icon: UserRound, title: t("emptyTitle"), description: t("emptyBody") }}
      rowTo={openTo}
      rowLabel={(row) => row.name || t("unnamed")}
      canSelectRow={search.trashed ? deletable : undefined}
      lifecycle={{
        canTrash: canDelete,
        canRestore: canDelete,
        canDelete,
        canDeleteRow: deletable,
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
  );
}
