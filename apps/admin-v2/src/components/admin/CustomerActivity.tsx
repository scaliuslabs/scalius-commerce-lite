import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { unixToDate } from "@scalius/shared/timestamps";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { fetchCustomerHistory } from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { resourceMessages } from "~/i18n/resource";

const PAGE = { orders: 10, history: 10 } as const;

const day = (value: string | number | null | undefined) => {
  const date = unixToDate(value);
  return date ? formatDateTime(date, { dateStyle: "medium" }) : "";
};

/** Orders and the change log for one customer (Shopify's customer timeline). */
export function CustomerActivity({ customerId }: { customerId: string }) {
  const t = useMessages(customersMessages);
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const { fmt } = useCurrency();
  const orders = useInfiniteQuery({
    queryKey: queryKeys.customers.history(customerId, { part: "orders" }),
    queryFn: ({ pageParam }) => fetchCustomerHistory(customerId, { ordersPage: pageParam, ordersLimit: PAGE.orders, historyPage: 1, historyLimit: PAGE.history }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.pagination.orders.hasNextPage ? last.pagination.orders.page + 1 : undefined),
  });
  const history = useInfiniteQuery({
    queryKey: queryKeys.customers.history(customerId, { part: "history" }),
    queryFn: ({ pageParam }) => fetchCustomerHistory(customerId, { historyPage: pageParam, historyLimit: PAGE.history, ordersPage: 1, ordersLimit: 1 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.pagination.history.hasNextPage ? last.pagination.history.page + 1 : undefined),
    enabled: orders.isSuccess,
  });

  if (orders.isError) {
    return (
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          {t("loadFailed")}
          <Button variant="outline" size="sm" onClick={() => void orders.refetch()}>{tr("retry")}</Button>
        </CardHeader>
      </Card>
    );
  }

  const first = orders.data?.pages[0];
  const orderRows = orders.data?.pages.flatMap((page) => page.orders) ?? [];
  const changes = history.data?.pages.flatMap((page) => page.history) ?? [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("recentOrders")}</CardTitle>
          {first ? (
            <p className="text-body text-muted-foreground">
              {first.customer.totalOrders === 1 ? t("orderCountOne") : t("orderCount", { count: first.customer.totalOrders })}
              {" · "}
              {t("spent")}: {fmt(first.customer.totalSpent)}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {orders.isPending ? null : orderRows.length === 0 ? (
            <p className="px-4 pb-4 text-body text-muted-foreground">{t("noOrders")}</p>
          ) : (
            <ul className="divide-y border-t">
              {orderRows.map((order) => (
                <li key={order.id}>
                  <Link
                    to="/admin/orders/$orderId"
                    params={{ orderId: order.id }}
                    className="flex min-h-11 items-center gap-3 px-4 py-2 text-body hover:bg-muted md:min-h-10"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">#{order.id.slice(0, 8)}</span>
                      <span className="block text-muted-foreground">{day(order.createdAt)}</span>
                    </span>
                    <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(to, order.status)}</Badge>
                    <span className="tabular-nums">{fmt(order.totalAmount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {orders.hasNextPage ? (
            <div className="border-t p-3 text-center">
              <Button variant="ghost" size="sm" disabled={orders.isFetchingNextPage} onClick={() => void orders.fetchNextPage()}>
                {t("loadMore")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("history")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isSuccess && changes.length === 0 ? <p className="text-body text-muted-foreground">{t("noHistory")}</p> : null}
          <ol className="space-y-3">
            {changes.map((change) => (
              <li key={change.id} className="text-body">
                <p>
                  <span className="font-medium">
                    {t(change.changeType === "created" ? "changeCreated" : change.changeType === "deleted" ? "changeDeleted" : "changeUpdated")}
                  </span>
                  <span className="text-muted-foreground"> · {day(change.createdAt)}</span>
                </p>
                <p className="text-muted-foreground">
                  {[change.name, change.phone, change.email, change.address, change.areaName ?? change.area, change.zoneName ?? change.zone, change.cityName ?? change.city]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ol>
          {history.hasNextPage ? (
            <Button variant="ghost" size="sm" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              {t("loadMore")}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
