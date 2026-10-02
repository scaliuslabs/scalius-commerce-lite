import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SupplierList } from "~/components/admin/purchasing/SupplierList";
import { supplierListQuery, validateSupplierListSearch } from "~/components/admin/purchasing/purchasing-list-state";
import { suppliersQueryOptions } from "~/lib/api-query-options/purchasing";
import { readListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/suppliers/")({
  // Only the Active/Archived tab is shareable; the search stays in this tab's session.
  validateSearch: validateSupplierListSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    warmRouteQuery(queryClient, suppliersQueryOptions(supplierListQuery(deps.status ?? "active", readListSearch("suppliers"), 1, 50))),
  head: () => pageHead("suppliers"),
  errorComponent: RouteErrorComponent,
  component: SuppliersPage,
});

function SuppliersPage() {
  const { status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SupplierList
      tab={status ?? "active"}
      onTabChange={(next) => void navigate({ search: next === "archived" ? { status: "archived" } : {}, replace: true })}
    />
  );
}
