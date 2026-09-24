import { Fragment, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { unixToDate } from "@scalius/shared/timestamps";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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

type Snapshot = Record<"name" | "phone" | "email" | "address" | "area" | "zone" | "city", string>;
const FIELD_LABEL = {
  name: "fieldName",
  phone: "fieldPhone",
  email: "fieldEmail",
  address: "fieldAddress",
  area: "fieldArea",
  zone: "fieldZone",
  city: "fieldCity",
} as const;

function snapshot(change: {
  name: string | null; phone: string | null; email: string | null; address: string | null;
  area: string | null; areaName: string | null; zone: string | null; zoneName: string | null; city: string | null; cityName: string | null;
}): Snapshot {
  return {
    name: change.name ?? "",
    phone: change.phone ? formatPhoneForDisplay(change.phone) : "",
    email: change.email ?? "",
    address: change.address ?? "",
    area: change.areaName || change.area || "",
    zone: change.zoneName || change.zone || "",
    city: change.cityName || change.city || "",
  };
}

type HistoryPage = Awaited<ReturnType<typeof fetchCustomerHistory>>;
type HistoryEntry = HistoryPage["history"][number];
type CustomerFacts = HistoryPage["customer"];

/** Order moves between a guest record and the account that proved its contact. */
const isMove = (entry: HistoryEntry) => entry.changeType === "order_moved_in" || entry.changeType === "order_moved_out";

/** The next older entry that carries a contact snapshot (order moves carry none). */
function olderSnapshot(entries: HistoryEntry[], index: number): HistoryEntry | undefined {
  return entries.slice(index + 1).find((entry) => !isMove(entry));
}

/** Fills the `{token}` placeholders of a translated sentence with links. */
function withLinks(sentence: string, links: Record<string, ReactNode>): ReactNode {
  return sentence.split(/(\{\w+\})/).map((part, index) => {
    const token = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={index}>{token && token in links ? links[token] : part}</Fragment>;
  });
}

const linkClass = "text-link hover:underline";

function CustomerLink({ customer }: { customer: { id: string; name: string } }) {
  return (
    <Link to="/admin/customers/$customerId/edit" params={{ customerId: customer.id }} className={linkClass}>
      {customer.name}
    </Link>
  );
}

/**
 * How this record relates to a buyer account: a guest record still holding
 * orders the account hasn't claimed, a retired guest record merged into the
 * account, or an account with guest records left to claim.
 */
function AccountLinks({ customer }: { customer: CustomerFacts }) {
  const t = useMessages(customersMessages);
  const account = customer.linkedAccount;
  if (account && customer.deletedAt) {
    return (
      <Alert variant="info" role="note">
        <AlertTitle>{withLinks(t("mergedInto"), { name: <CustomerLink customer={account} /> })}</AlertTitle>
      </Alert>
    );
  }
  if (account) {
    return (
      <Alert variant="info" role="note">
        <AlertTitle>{t("guestOrders")}</AlertTitle>
        <AlertDescription>{withLinks(t("guestOrdersBody"), { name: <CustomerLink customer={account} /> })}</AlertDescription>
      </Alert>
    );
  }
  const guests = customer.guestRecords;
  if (guests.length === 0) return null;
  return (
    <Alert variant="info" role="note">
      <AlertDescription>
        <ul>
          {guests.map((guest) => (
            <li key={guest.id}>
              {withLinks(
                guest.orderCount === 1 ? t("guestOrdersOnOne") : t("guestOrdersOn", { count: guest.orderCount }),
                { name: <CustomerLink customer={guest} /> },
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** One line for an order that moved in from, or out to, another record. */
function OrderMove({ entry }: { entry: HistoryEntry }) {
  const t = useMessages(customersMessages);
  const order = entry.order ? (
    <Link to="/admin/orders/$orderId" params={{ orderId: entry.order.id }} className={linkClass}>
      {formatOrderNumber(entry.order.orderNumber, entry.order.id)}
    </Link>
  ) : "—";
  const name = entry.relatedCustomer ? <CustomerLink customer={entry.relatedCustomer} /> : "—";
  return (
    <li className="text-body">
      <p>
        {withLinks(t(entry.changeType === "order_moved_in" ? "orderMovedIn" : "orderMovedOut"), { order, name })}
        <span className="text-muted-foreground"> · {day(entry.createdAt)}</span>
      </p>
    </li>
  );
}

/** What an entry changed against the one before it (the next, older entry). */
function changedFields(current: Snapshot, previous: Snapshot | undefined) {
  return (Object.keys(FIELD_LABEL) as Array<keyof Snapshot>)
    .filter((field) => !previous || current[field] !== previous[field])
    .filter((field) => previous || current[field])
    .map((field) => ({ field, from: previous?.[field] ?? "", to: current[field] }));
}

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
      {first ? <AccountLinks customer={first.customer} /> : null}
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
                      <span className="block font-medium">{formatOrderNumber(order.orderNumber, order.id)}</span>
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
            {changes.map((change, index) => {
              if (isMove(change)) return <OrderMove key={change.id} entry={change} />;
              // Newest first: an update is shown as what it changed against the snapshot below it.
              const older = olderSnapshot(changes, index);
              const fields = change.changeType === "updated" && older
                ? changedFields(snapshot(change), snapshot(older))
                : changedFields(snapshot(change), undefined);
              if (change.changeType === "updated" && older && fields.length === 0) return null;
              return (
                <li key={change.id} className="text-body">
                  <p>
                    <span className="font-medium">
                      {t(change.changeType === "created" ? "changeCreated" : change.changeType === "deleted" ? "changeDeleted" : "changeUpdated")}
                    </span>
                    <span className="text-muted-foreground"> · {day(change.createdAt)}</span>
                  </p>
                  {change.changeType === "deleted" ? null : (
                    <ul className="text-muted-foreground">
                      {fields.map(({ field, from, to }) => (
                        <li key={field} className="break-words">
                          {t(FIELD_LABEL[field])}: {change.changeType === "updated" && older ? `${from || "—"} → ${to || t("removed")}` : to}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
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
