import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PurchaseOrderList } from "~/components/admin/purchasing/PurchaseOrderList";
import {
  purchaseOrderListQuery,
  validatePurchaseOrderListSearch,
} from "~/components/admin/purchasing/purchasing-list-state";
import { readListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/inventory/purchase-orders/")({
  // The status tab and supplier may be shared; the search stays in this tab's session.
  validateSearch: validatePurchaseOrderListSearch,
  loaderDeps: ({ search }) => search,
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient }, deps }) => {
    const { purchaseOrdersQueryOptions: options } = await import("~/lib/api-query-options/purchasing");
    return warmRouteQuery(
      queryClient,
      options(purchaseOrderListQuery(deps.status ?? "all", readListSearch("purchaseOrders"), 1, 50, deps.supplier)),
    );
  },
  head: () => pageHead("purchaseOrders"),
  errorComponent: RouteErrorComponent,
  component: PurchaseOrdersPage,
});

function PurchaseOrdersPage() {
  const { status, supplier } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <PurchaseOrderList
      tab={status ?? "all"}
      supplierId={supplier}
      onTabChange={(next) => void navigate({
        search: (previous) => ({ ...previous, status: next === "all" ? undefined : next }),
        replace: true,
      })}
      onSupplierChange={(next) => void navigate({
        search: (previous) => ({ ...previous, supplier: next }),
        replace: true,
      })}
    />
  );
}
