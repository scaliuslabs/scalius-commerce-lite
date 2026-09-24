import { useCallback } from "react";
import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { OrderList } from "~/components/admin/order-list/OrderList";
import {
  ORDER_SEARCH_DEFAULTS,
  ORDER_SEARCH_LIST,
  orderListQuery,
  validateOrderSearch,
  type OrderListSearch,
} from "~/components/admin/order-list/order-list-search";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { readListSearch } from "~/lib/list-search";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/orders/_list/")({
  validateSearch: validateOrderSearch,
  search: { middlewares: [stripSearchParams(ORDER_SEARCH_DEFAULTS)] },
  loaderDeps: ({ search }) => search,
  staleTime: 30_000,
  loader: async ({ context: { queryClient }, deps }) => {
    // The search term lives in this tab's session (empty on the server), never in the URL.
    const term = typeof window === "undefined" ? "" : readListSearch(ORDER_SEARCH_LIST);
    await warmRouteQuery(queryClient, ordersQueryOptions(orderListQuery(deps, term)));
  },
  head: () => pageHead("orders"),
  component: OrdersIndexPage,
  errorComponent: RouteErrorComponent,
});

function OrdersIndexPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const onChange = useCallback(
    (updates: Partial<OrderListSearch>, options?: { replace?: boolean }) => {
      void navigate({
        search: (previous) => ({ ...previous, ...updates }),
        replace: options?.replace,
      });
    },
    [navigate],
  );
  return <OrderList search={search} onChange={onChange} />;
}
