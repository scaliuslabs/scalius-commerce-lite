import { useCallback } from "react";
import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { OrderList } from "~/components/admin/order-list/OrderList";
import {
  ORDER_SEARCH_DEFAULTS,
  orderListQuery,
  validateOrderSearch,
  type OrderListSearch,
} from "~/components/admin/order-list/order-list-search";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import { orderMessages } from "~/i18n/orders";

export const Route = createFileRoute("/admin/orders/_list/")({
  validateSearch: validateOrderSearch,
  search: { middlewares: [stripSearchParams(ORDER_SEARCH_DEFAULTS)] },
  loaderDeps: ({ search }) => search,
  staleTime: 30_000,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, ordersQueryOptions(orderListQuery(deps)));
  },
  head: () => ({ meta: [{ title: `${translate(orderMessages, "orders")} | Scalius Admin` }] }),
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
