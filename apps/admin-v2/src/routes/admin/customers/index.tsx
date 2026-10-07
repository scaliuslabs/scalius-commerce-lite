import { lazy, Suspense, useMemo, useState } from "react";
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
import { NO_CURSOR } from "~/lib/list-helpers";
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { customersQueryOptions } from "~/lib/api-query-options/customers";
import { useCurrency } from "~/hooks/use-currency";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { usePermissions } from "~/contexts/PermissionContext";
import { Button } from "~/components/ui/button";
import { ResourceListPage } from "~/components/admin/resource/ResourceListPage";
import { CustomerListFilters } from "~/components/admin/customers/CustomerListFilters";
import { LazyImportDialog } from "~/components/admin/store-transfer/LazyImportDialog";
import { resourceMessages } from "~/i18n/resource";
import {
  CUSTOMER_FILTER_PARAMS,
  customerListFilters,
  validateCustomerSearch,
  type CustomerListSearch,
} from "~/components/admin/customers/customer-list-search";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { getCustomerColumns, type CustomerListItem } from "~/components/admin/customers/customer-columns";
import { pageHead } from "~/i18n/page-titles";

type Customer = CustomerListItem;

/** The list's own search key per tab ("customers", "customers.subscribers", "customers.trash"). */
const searchKey = (search: CustomerListSearch) => listSearchKey("customers", search, "view");

function listQuery(search: CustomerListSearch, term: string) {
  // A numbered page (older links) or a cursor, never both.
  const cursor = search.after ? { after: search.after } : search.before ? { before: search.before } : null;
  return customersQueryOptions({
    ...(cursor ?? { page: search.page }),
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    ...customerListFilters(search),
  });
}

// The bulk tag dialog and the export dialog load when first used: the list
// renders without their tag field, radio choices and CSV writer.
const CustomerBulkActions = lazy(() => import("~/components/admin/customers/CustomerBulkActions").then((module) => ({ default: module.CustomerBulkActions })));
const ExportCustomersDialog = lazy(() => import("~/components/admin/customers/ExportCustomersDialog").then((module) => ({ default: module.ExportCustomersDialog })));

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
  const r = useMessages(resourceMessages);
  const [importing, setImporting] = useState(false);
  const openTo = (row: Customer) => `/admin/customers/${row.id}/edit`;
  // The export dialog: from the header (the filters) or the bulk bar (the selection).
  const [exporting, setExporting] = useState<{ open: boolean; ids: string[] }>({ open: false, ids: [] });
  const exportLoaded = useOpenedOnce(exporting.open);
  // Same query as the table (shared cache): the export dialog names how many match.
  const { data: listed } = useQuery(listQuery(search, term));

  const columns = useMemo(
    () => getCustomerColumns({ t, fmt, rowTo: (row) => (search.trashed ? undefined : openTo(row)) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `openTo` only builds a path from the row.
    [t, fmt, search.trashed],
  );

  return (
    <>
      <ResourceListPage<Customer>
        title={t("customers")}
        actions={
          <>
            {hasPermission(PERMISSIONS.CUSTOMERS_CREATE) || canEdit ? (
              <Button variant="outline" onClick={() => setImporting(true)}>{r("import")}</Button>
            ) : null}
            <Button variant="outline" onClick={() => setExporting({ open: true, ids: [] })}>{t("export")}</Button>
            {hasPermission(PERMISSIONS.CUSTOMERS_CREATE) ? <Button asChild><Link to="/admin/customers/new">{t("addCustomer")}</Link></Button> : null}
          </>
        }
        search={search}
        list="customers"
        appActions="customer"
        query={listQuery(search, term)}
        pageQuery={(page, limit) => listQuery({ ...search, page, limit, ...NO_CURSOR }, term)}
        cursorPaging
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
          <Suspense fallback={null}>
            <CustomerBulkActions
              rows={rows}
              done={done}
              canEdit={canEdit}
              onExport={() => setExporting({ open: true, ids: rows.map((row) => row.id) })}
            />
          </Suspense>
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
      <LazyImportDialog kind="customers" open={importing} onOpenChange={setImporting} />
      {exportLoaded ? (
        <Suspense fallback={null}>
          <ExportCustomersDialog
            open={exporting.open}
            onOpenChange={(open) => setExporting((current) => ({ ...current, open }))}
            filters={customerListFilters(search)}
            selectedIds={exporting.ids}
            // A capped count is a lower bound: the dialog then names the filters, not a number.
            total={term || listed?.pagination.totalIsCapped ? null : listed?.pagination.total ?? null}
            searchActive={Boolean(term)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
