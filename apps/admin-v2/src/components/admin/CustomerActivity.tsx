import { Fragment, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatOrderNumber } from "@scalius/shared/order-utils";
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
import { customerTitle, type CustomerTitleInput } from "~/lib/customer-title";
import { resourceMessages } from "~/i18n/resource";

const PAGE = { orders: 10, history: 10 } as const;

const day = (value: string | number | null | undefined) => {
  const date = unixToDate(value);
  return date ? formatDateTime(date, { dateStyle: "medium" }) : "";
};

/** Change-log entries carry the time too: several can land on one day. */
const when = (value: string | number | null | undefined) => {
  const date = unixToDate(value);
  return date ? formatDateTime(date, { dateStyle: "medium", timeStyle: "short" }) : "";
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
type CustomerMessage = keyof (typeof customersMessages)["en"];

const CHANGE_LABEL: Partial<Record<string, CustomerMessage>> = {
  created: "changeCreated",
  updated: "changeUpdated",
  deleted: "changeDeleted",
  restored: "changeRestored",
};

/** Order events: filed to an account at checkout, or moved between a guest record and an account. */
const isOrderEvent = (entry: HistoryEntry) =>
  entry.changeType === "order_linked" || entry.changeType === "order_moved_in" || entry.changeType === "order_moved_out";

/** The next older entry whose contact snapshot an update is compared with (order events aren't edits). */
function olderSnapshot(entries: HistoryEntry[], index: number): HistoryEntry | undefined {
  return entries.slice(index + 1).find((entry) => !isOrderEvent(entry));
}

/** The sentence for a linking event, worded by the contact that proved it (or the plain wording without one). */
function linkSentence(entry: HistoryEntry): CustomerMessage {
  const base = ({
    signed_up: "signedUp",
    order_linked: "orderLinked",
    order_moved_in: "orderMovedIn",
    order_moved_out: "orderMovedOut",
  } as const)[entry.changeType as "signed_up" | "order_linked" | "order_moved_in" | "order_moved_out"];
  if (entry.verifiedContact === "email") return `${base}Email`;
  if (entry.verifiedContact === "phone") return `${base}Phone`;
  return base;
}

/** Fills the `{token}` placeholders of a translated sentence with links. */
function withLinks(sentence: string, links: Record<string, ReactNode>): ReactNode {
  return sentence.split(/(\{\w+\})/).map((part, index) => {
    const token = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={index}>{token && token in links ? links[token] : part}</Fragment>;
  });
}

const linkClass = "text-link hover:underline";

/** A link to another customer record, titled the same way as everywhere else. */
function CustomerLink({ customer }: { customer: CustomerTitleInput & { id: string } }) {
  const t = useMessages(customersMessages);
  return (
    <Link to="/admin/customers/$customerId/edit" params={{ customerId: customer.id }} className={linkClass}>
      {customerTitle(customer, t).title}
    </Link>
  );
}

/**
 * Other active customers with the same phone (family, a typo): links only,
 * never a merge or claim.
 */
function SamePhone({ customer }: { customer: CustomerFacts }) {
  const t = useMessages(customersMessages);
  if (customer.samePhone.length === 0) return null;
  const names = customer.samePhone.map((other, index) => (
    <Fragment key={other.id}>
      {index > 0 ? ", " : null}
      <CustomerLink customer={other} />
    </Fragment>
  ));
  return <p className="text-body text-muted-foreground">{withLinks(t("samePhoneAs"), { names })}</p>;
}

/** " · by Nasrin", " · by the buyer", " · automatic"; nothing for older entries without an author. */
function Author({ author }: { author: HistoryEntry["author"] }) {
  const t = useMessages(customersMessages);
  if (!author) return null;
  const text = author.kind === "buyer"
    ? t("byBuyer")
    : author.kind === "system"
      ? t("automatic")
      : author.name ? t("byStaff", { name: author.name }) : t("byStaffUnknown");
  return <> · {text}</>;
}

/** One line for a sign-up, or an order linked to, moved into or moved out of this record. */
function LinkEvent({ entry }: { entry: HistoryEntry }) {
  const t = useMessages(customersMessages);
  const order = entry.order ? (
    <Link to="/admin/orders/$orderId" params={{ orderId: entry.order.id }} className={linkClass}>
      {formatOrderNumber(entry.order.orderNumber, entry.order.id)}
    </Link>
  ) : "—";
  const name = entry.relatedCustomer ? <CustomerLink customer={entry.relatedCustomer} /> : "—";
  const sentence = linkSentence(entry);
  // The worded sentences carry their own date; the plain move wording keeps it after a dot.
  const dated = sentence !== "orderMovedIn" && sentence !== "orderMovedOut";
  return (
    <li className="text-body">
      <p>
        {withLinks(t(sentence), { order, name, date: when(entry.createdAt) })}
        <span className="text-muted-foreground">
          {dated ? null : ` · ${when(entry.createdAt)}`}
          <Author author={entry.author} />
        </span>
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
      {first ? <SamePhone customer={first.customer} /> : null}
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
                      {/* Each order keeps the name it was placed with: a guest record can hold orders from different people. */}
                      <span className="block truncate font-medium">
                        {formatOrderNumber(order.orderNumber, order.id)} · {order.customerName}
                      </span>
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
              if (change.changeType === "signed_up" || isOrderEvent(change)) return <LinkEvent key={change.id} entry={change} />;
              // Newest first: an update is shown as what it changed against the snapshot below it.
              const older = olderSnapshot(changes, index);
              const fields = change.changeType === "updated" && older
                ? changedFields(snapshot(change), snapshot(older))
                : changedFields(snapshot(change), undefined);
              if (change.changeType === "updated" && older && fields.length === 0) return null;
              const lifecycle = change.changeType === "deleted" || change.changeType === "restored";
              return (
                <li key={change.id} className="text-body">
                  <p>
                    <span className="font-medium">{t(CHANGE_LABEL[change.changeType] ?? "changeUpdated")}</span>
                    <span className="text-muted-foreground"> · {when(change.createdAt)}<Author author={change.author} /></span>
                  </p>
                  {lifecycle ? null : (
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
