import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { LazyFraudCheckIndicator } from "~/components/admin/order-list/LazyFraudCheckIndicator";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { formatLocationParts } from "~/lib/location-presentation";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { customerContactLinks } from "./contact-links";
import { OrderDetailsDialog } from "./OrderDetailsDialog";
import type { Order } from "./types";

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * Customer, delivery address and the manual courier fraud check. The order
 * keeps the name it was placed with; the record it's filed under is linked
 * separately, since a guest record (keyed by phone) can hold several people.
 */
export function OrderCustomerCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const actions = useOrderActionPermissions();
  const [editing, setEditing] = useState(false);
  const contact = customerContactLinks(order.customerPhone);
  const address = formatLocationParts(order.shippingAddress, order.areaName, order.zoneName, order.cityName);
  const canEditDetails = actions.canEditOrders && order.editReadiness.details.allowed;
  const record = order.customerRecord ?? null;
  // An account or merchant-added customer named differently from this order: say so, so the mismatch is seen.
  const orderedAs = record !== null && record.kind !== "guest" && !sameName(record.name, order.customerName);

  return (
    <Card>
      <div className="divide-y">
        <section className="space-y-1 px-6 py-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{t("customer.title")}</h2>
            {canEditDetails ? (
              <Button variant="ghost" size="icon-sm" aria-label={t("details.title")} onClick={() => setEditing(true)}>
                <Pencil className="size-4" />
              </Button>
            ) : null}
          </div>
          <p className="font-medium">{order.customerName}</p>
          {record ? (
            <Link
              to="/admin/customers/$customerId/edit"
              params={{ customerId: record.id }}
              className="block text-link hover:underline"
            >
              {record.kind === "guest" ? t("customer.guestRecord", { phone: formatPhoneForDisplay(record.phone) }) : record.name}
            </Link>
          ) : null}
          {orderedAs ? <p className="text-muted-foreground">{t("customer.orderedAs", { name: order.customerName })}</p> : null}
          <p className="font-mono text-muted-foreground">{formatPhoneForDisplay(order.customerPhone)}</p>
          {order.customerEmail ? (
            <a href={`mailto:${order.customerEmail}`} className="flex min-h-11 items-center break-all text-muted-foreground hover:text-foreground sm:min-h-0">
              {order.customerEmail}
            </a>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" size="sm" asChild>
              <a href={contact.call} aria-label={t("contact.callName", { name: order.customerName })}>{t("contact.call")}</a>
            </Button>
            {contact.whatsapp ? (
              <Button variant="outline" size="sm" asChild>
                <a href={contact.whatsapp} target="_blank" rel="noopener noreferrer" aria-label={t("contact.whatsappName", { name: order.customerName })}>
                  {t("contact.whatsapp")}
                </a>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <a href={contact.sms} aria-label={t("contact.smsName", { name: order.customerName })}>{t("contact.sms")}</a>
            </Button>
          </div>
        </section>
        <section className="space-y-1 px-6 py-4">
          <h2 className="font-semibold">{t("address.title")}</h2>
          <p className="text-muted-foreground">{address || t("address.none")}</p>
          {order.shippingMethodName ? <p className="text-muted-foreground">{order.shippingMethodName}</p> : null}
        </section>
        {actions.canViewFraudCheck ? (
          <section className="flex items-center justify-between gap-3 px-6 py-4">
            <div>
              <h2 className="font-semibold">{t("fraud.title")}</h2>
              <p className="text-muted-foreground">{t("fraud.help")}</p>
            </div>
            <LazyFraudCheckIndicator phone={order.customerPhone} customerName={order.customerName} />
          </section>
        ) : null}
      </div>
      <OrderDetailsDialog order={order} open={editing} onOpenChange={setEditing} />
    </Card>
  );
}
