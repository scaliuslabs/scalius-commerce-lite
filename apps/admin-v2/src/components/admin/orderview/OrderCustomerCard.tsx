import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { LazyFraudCheckIndicator } from "~/components/admin/order-list/LazyFraudCheckIndicator";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { formatLocationParts } from "~/lib/location-presentation";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { customerContactLinks } from "./contact-links";
import type { Order } from "./types";

/** Customer, delivery address and the manual courier fraud check. */
export function OrderCustomerCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const contact = customerContactLinks(order.customerPhone);
  const address = formatLocationParts(order.shippingAddress, order.areaName, order.zoneName, order.cityName);

  return (
    <Card>
      <div className="divide-y">
        <section className="space-y-1 px-6 py-4">
          <h2 className="font-semibold">{t("customer.title")}</h2>
          {order.customerId ? (
            <Link
              to="/admin/customers/$customerId/edit"
              params={{ customerId: order.customerId }}
              className="block text-primary hover:underline"
            >
              {order.customerName}
            </Link>
          ) : (
            <p>{order.customerName}</p>
          )}
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
        <section className="flex items-center justify-between gap-3 px-6 py-4">
          <div>
            <h2 className="font-semibold">{t("fraud.title")}</h2>
            <p className="text-muted-foreground">{t("fraud.help")}</p>
          </div>
          <LazyFraudCheckIndicator phone={order.customerPhone} />
        </section>
      </div>
    </Card>
  );
}
