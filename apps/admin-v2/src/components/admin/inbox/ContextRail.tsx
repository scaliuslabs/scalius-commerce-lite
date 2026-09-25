import { Link } from "@tanstack/react-router";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { formatSavedMinorAmount } from "~/lib/order-tax-presentation";
import { formatOrderDate } from "../orderview/formatters";
import { statusBadgeVariant } from "../orderview/status-badges";
import type { StaffThread } from "~/lib/api-query-options/inbox";

/** The thread's context (Shopify Inbox's right rail): customer, order and its requests. */
export function ContextRail({ thread, className }: { thread: StaffThread; className?: string }) {
  const t = useMessages(inboxMessages);
  const od = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const order = thread.order;
  const currency = order?.currencyCode ?? "BDT";

  return (
    <aside aria-label={t("rail")} className={cn("flex flex-col divide-y overflow-y-auto", className)}>
      <section className="flex flex-col gap-1 p-4">
        <h3 className="text-heading-sm">{t("customerLabel")}</h3>
        <p className="break-words">{thread.customerName?.trim() || t("unknownCustomer")}</p>
        {thread.customerId ? (
          <Link to="/admin/customers/$customerId/edit" params={{ customerId: thread.customerId }} className="text-body text-link hover:underline">
            {t("viewCustomer")}
          </Link>
        ) : null}
      </section>
      {order ? (
        <section className="flex flex-col gap-2 p-4">
          <h3 className="text-heading-sm">{t("order")}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <code>{order.orderNumber}</code>
            <Badge variant={statusBadgeVariant(order.status, "order")}>{`status.${order.status}` in orderMessages.en ? o(`status.${order.status}` as "status.pending") : order.status}</Badge>
          </div>
          <p className="tabular-nums">
            {formatSavedMinorAmount(order.totalAmountMinor, { currencyCode: currency, decimalPlaces: getDecimalPlaces(currency) })}
          </p>
          {order.createdAt ? <p className="text-body text-muted-foreground">{t("placedOn", { date: formatOrderDate(order.createdAt) ?? "" })}</p> : null}
          <Link to="/admin/orders/$orderId" params={{ orderId: order.id }} className="text-body text-link hover:underline">
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
