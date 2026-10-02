import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SupplierList } from "~/components/admin/purchasing/SupplierList";
import { supplierListQuery, validateSupplierListSearch } from "~/components/admin/purchasing/purchasing-list-state";
import { readListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/suppliers/")({
  // Only the Active/Archived tab is shareable; the search stays in this tab's session.
  validateSearch: validateSupplierListSearch,
  loaderDeps: ({ search }) => search,
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient }, deps }) => {
    const { suppliersQueryOptions: options } = await import("~/lib/api-query-options/purchasing");
    return warmRouteQuery(queryClient, options(supplierListQuery(deps.status ?? "active", readListSearch("suppliers"), 1, 50)));
  },
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
