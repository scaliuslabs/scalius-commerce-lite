import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminConversationsByIdContext } from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";
import { useHasPermission } from "~/contexts/PermissionContext";
import { apiData } from "~/lib/api";
import { pollWhileOffline } from "~/lib/admin-query-client";
import { Button } from "~/components/ui/button";
import { ListDate } from "../data-table/ListDate";
import { ConversationAmount, ConversationProductCards } from "./ConversationProductCards";
import { Link } from "@tanstack/react-router";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { formatSavedMinorAmount } from "~/lib/order-tax-presentation";
import { formatOrderDate } from "../orderview/formatters";
import { statusBadgeVariant } from "../orderview/status-badges";
import type { StaffThread } from "~/lib/api-query-options/inbox";
import { SubjectContext } from "./subject-context";

/** The thread's context (Shopify Inbox's right rail): customer, order and its requests. */
export function ContextRail({ thread, className }: { thread: StaffThread; className?: string }) {
  const t = useMessages(inboxMessages);
  const od = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const canViewCustomer = useHasPermission(PERMISSIONS.CUSTOMERS_VIEW);
  const canViewOrders = useHasPermission(PERMISSIONS.ORDERS_VIEW);
  const context = useQuery({ queryKey: ["conversations", "context", thread.id, canViewCustomer, canViewOrders],
    queryFn: () => apiData(getApiV1AdminConversationsByIdContext({ path: { id: thread.id } })),
    refetchInterval: pollWhileOffline(20_000), staleTime: 0 });
  const customer = canViewCustomer ? context.data?.customer : null;
  const orders = canViewOrders ? context.data?.recentOrders : null;
  const cart = context.data?.cartShare;
  const order = canViewOrders ? thread.order : null;
  const currency = order?.currencyCode ?? "BDT";

  return (
    <aside aria-label={t("rail")} className={cn("flex flex-col divide-y overflow-y-auto", className)}>
      {context.isError ? <div className="p-4"><p className="text-body text-destructive">{t("contextFailed")}</p><Button variant="outline" onClick={() => void context.refetch()}>{t("retry")}</Button></div> : null}
      <section className="flex flex-col gap-1 p-4">
        <h3 className="text-heading-sm">{t("customerLabel")}</h3>
        <p className="break-words">{thread.customerName?.trim() || t("unknownCustomer")}</p>
        {customer?.phone ? <p className="wrap-anywhere">{formatPhoneForDisplay(customer.phone, getStoreRegion())}</p> : null}
        {customer?.email ? <p className="wrap-anywhere">{customer.email}</p> : null}
        {thread.customerId && canViewCustomer ? (
          <Link to="/admin/customers/$customerId/edit" params={{ customerId: thread.customerId }} className="inline-flex min-h-11 min-w-6 items-center text-body text-link hover:underline sm:min-h-6">
            {t("viewCustomer")}
          </Link>
        ) : null}
      </section>
      {orders ? <section className="flex flex-col gap-2 p-4"><h3 className="text-heading-sm">{t("recentOrders")}</h3>
        {orders.length === 0 ? <p className="text-body text-muted-foreground">{t("noRecentOrders")}</p> : <ul className="space-y-3">{orders.slice(0, 3).map((recent) => <li key={recent.id} className="flex flex-col gap-1">
          <Link to="/admin/orders/$orderId" params={{ orderId: recent.id }} className="inline-flex min-h-11 items-center text-link hover:underline sm:min-h-6">{recent.orderNumber}</Link>
          <div className="flex flex-wrap gap-2"><Badge variant={statusBadgeVariant(recent.status, "order")}>{orderStatusLabel(o, recent.status)}</Badge>{recent.total ? <ConversationAmount {...recent.total} /> : null}</div>
          <ListDate value={recent.createdAt} />
        </li>)}</ul>}
      </section> : null}
      {cart ? <section className="flex flex-col gap-2 p-4"><h3 className="text-heading-sm">{t("sharedCart")}</h3>
        <p className="text-body text-muted-foreground">{t("cartSnapshot")} <ListDate value={cart.sharedAt} /></p>
        {cart.withdrawnAt ? <p className="text-body text-muted-foreground">{t("cartWithdrawn")}</p> : <>
          <ConversationProductCards products={cart.products ?? []} />
          <ul>{cart.lines.map((line) => <li key={line.skuId} className="text-body text-muted-foreground">{t("cartQuantity", { name: cart.products?.find((product) => product.skuId === line.skuId)?.title ?? t("productUnavailable"), count: line.quantity })}</li>)}</ul>
        </>}
      </section> : null}
      <SubjectContext thread={thread} />
      {order ? (
        <section className="flex flex-col gap-2 p-4">
          <h3 className="text-heading-sm">{t("order")}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <code>{order.orderNumber}</code>
            <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(o, order.status)}</Badge>
          </div>
          <p className="tabular-nums">
            {formatSavedMinorAmount(order.totalAmountMinor, { currencyCode: currency, decimalPlaces: getDecimalPlaces(currency) })}
          </p>
          {order.createdAt ? <p className="text-body text-muted-foreground">{t("placedOn", { date: formatOrderDate(order.createdAt) ?? "" })}</p> : null}
          <Link to="/admin/orders/$orderId" params={{ orderId: order.id }} className="inline-flex min-h-11 min-w-6 items-center text-body text-link hover:underline sm:min-h-6">
            {t("viewOrder")}
          </Link>
        </section>
      ) : null}
      {order ? (
        <section className="flex flex-col gap-2 p-4">
          <h3 className="text-heading-sm">{t("requests")}</h3>
          {thread.cases.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("noRequests")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {thread.cases.map((request) => (
                <li key={request.id} className="flex flex-wrap items-center gap-2">
                  <span>{`request.${request.type}` in orderMessages.en ? o(`request.${request.type}` as "request.return") : request.label}</span>
                  <Badge variant={statusBadgeVariant(request.status)}>{orderDetailLabel(od, "requests.status.", request.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </aside>
  );
}
