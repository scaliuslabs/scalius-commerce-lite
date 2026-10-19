import { Suspense, lazy, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { LazyFraudCheckIndicator } from "~/components/admin/order-list/LazyFraudCheckIndicator";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { formatBillingAddressLines, formatShippingAddress } from "~/lib/location-presentation";
import { countryName } from "~/lib/country-name";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";
import { customerContactLinks } from "./contact-links";
import { formatOrderTimestamp, orderTimestampIso } from "./formatters";
import type { Order, OrderAppRiskCheck, OrderHold } from "./types";

// The edit dialog checks phones with libphonenumber's metadata: it loads
// just after the page, not as part of it.
const OrderDetailsDialog = lazy(() => import("./OrderDetailsDialog").then((module) => ({ default: module.OrderDetailsDialog })));

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

const RISK_VARIANT: Record<OrderAppRiskCheck["level"], BadgeVariant> = {
  low: "success",
  medium: "warning",
  high: "destructive",
};

function HoldReleased({ hold }: { hold: OrderHold }) {
  const t = useMessages(orderDetailMessages);
  const when = formatOrderTimestamp(hold.releasedAt);
  return when ? (
    <p className="text-muted-foreground">
      <time dateTime={orderTimestampIso(hold.releasedAt)}>{t("holds.releasedAt", { when })}</time>
    </p>
  ) : null;
}

/**
 * Apps' risk checks of the order (`ctx.orders.assessRisk`), as advice: the level is a
 * word on the badge, not only its colour, and nothing here acts on the order.
 * A hold an app placed and staff released shows under that app's check (an
 * open one is the page's hold notice). Part of the order read, so everyone
 * who can open the order sees it.
 */
function AppRiskChecks({ checks, released }: { checks: OrderAppRiskCheck[]; released: OrderHold[] }) {
  const t = useMessages(orderDetailMessages);
  const unchecked = released.filter((hold) => !checks.some((check) => check.appId === hold.appId));
  return (
    <section className="space-y-3 p-4">
      <div className="space-y-1">
        <h2 className="font-semibold">{t("appRisk.title")}</h2>
        <p className="text-muted-foreground">{t("appRisk.advice")}</p>
      </div>
      <ul className="space-y-3">
        {checks.map((check, index) => {
          const when = formatOrderTimestamp(check.checkedAt);
          const hold = released.find((candidate) => candidate.appId === check.appId);
          return (
            <li key={`${check.appId}:${index}`} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link to="/admin/apps/$pluginId" params={{ pluginId: check.appId }} className="font-medium text-link hover:underline">
                  {check.appName}
                </Link>
                <Badge variant={RISK_VARIANT[check.level]}>{t(`appRisk.${check.level}`)}</Badge>
              </div>
              {check.reasons.length > 0 ? (
                <ul className="list-disc space-y-0.5 ps-5">
                  {check.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}
                </ul>
              ) : null}
              {when ? (
                <p className="text-muted-foreground">
                  <time dateTime={orderTimestampIso(check.checkedAt)}>{t("appRisk.checkedAt", { when })}</time>
                </p>
              ) : null}
              {hold ? <HoldReleased hold={hold} /> : null}
            </li>
          );
        })}
        {unchecked.map((hold) => (
          <li key={hold.id} className="space-y-1">
            <Link to="/admin/apps/$pluginId" params={{ pluginId: hold.appId }} className="font-medium text-link hover:underline">
              {hold.appName}
            </Link>
            <HoldReleased hold={hold} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Customer, delivery address, the manual courier fraud check and apps' risk
 * checks. The order keeps the name it was placed with; the record it's filed
 * under is linked separately, since a guest record (keyed by phone) can hold
 * several people.
 */
export function OrderCustomerCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const actions = useOrderActionPermissions();
  const [editing, setEditing] = useState(false);
  // An order placed without a phone (a digital or service order) has no call, SMS or fraud check.
  const contact = order.customerPhone ? customerContactLinks(order.customerPhone) : null;
  // WhatsApp goes to the separate number the buyer gave, when there is one.
  const whatsappLink = order.customerWhatsapp ? customerContactLinks(order.customerWhatsapp).whatsapp : contact?.whatsapp ?? null;
  const address = formatShippingAddress(order, countryName);
  // The recipient when the order ships to someone other than its contact.
  const recipient = [order.shippingName, order.shippingCompany].filter(Boolean).join(", ");
  // The billing address (Shopify's rule): its own lines, or "same as delivery"; none on older orders.
  const billingLines = formatBillingAddressLines(order, countryName);
  const billingRecipient = [order.billingName, order.billingCompany].filter(Boolean).join(", ");
  const canEditDetails = actions.canEditOrders && order.editReadiness.details.allowed;
  const record = order.customerRecord ?? null;
  // An account or merchant-added customer named differently from this order: say so, so the mismatch is seen.
  const orderedAs = record !== null && record.kind !== "guest" && !sameName(record.name, order.customerName);
  const released = (order.holds ?? []).filter((hold) => hold.releasedAt !== null);

  return (
    <Card>
      <div className="divide-y">
        <section className="space-y-1 p-4">
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
              className="flex min-h-11 min-w-6 items-center text-link hover:underline sm:min-h-6"
            >
              {record.kind !== "guest"
                ? record.name
                : record.phone
                  ? t("customer.guestRecord", { phone: formatPhoneForDisplay(record.phone, getStoreRegion()) })
                  : t("customer.guestRecordEmail", { email: order.customerEmail ?? "" })}
            </Link>
          ) : null}
          {orderedAs ? <p className="text-muted-foreground">{t("customer.orderedAs", { name: order.customerName })}</p> : null}
          {order.customerPhone ? (
            <p className="font-mono text-muted-foreground">{formatPhoneForDisplay(order.customerPhone, getStoreRegion())}</p>
          ) : (
            <p className="text-muted-foreground">{t("customer.noPhone")}</p>
          )}
          {order.customerWhatsapp ? (
            <p className="font-mono text-muted-foreground">{t("contact.whatsapp")}: {formatPhoneForDisplay(order.customerWhatsapp, getStoreRegion())}</p>
          ) : null}
          {order.customerEmail ? (
            <a href={`mailto:${order.customerEmail}`} className="flex min-h-11 items-center break-all text-muted-foreground hover:text-foreground sm:min-h-6">
              {order.customerEmail}
            </a>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-2 empty:hidden">
            {contact ? (
              <Button variant="outline" size="sm" asChild>
                <a href={contact.call} aria-label={t("contact.callName", { name: order.customerName })}>{t("contact.call")}</a>
              </Button>
            ) : null}
            {whatsappLink ? (
              <Button variant="outline" size="sm" asChild>
                <a href={whatsappLink} target="_blank" rel="noopener noreferrer" aria-label={t("contact.whatsappName", { name: order.customerName })}>
                  {t("contact.whatsapp")}
                </a>
              </Button>
            ) : null}
            {contact ? (
              <Button variant="outline" size="sm" asChild>
                <a href={contact.sms} aria-label={t("contact.smsName", { name: order.customerName })}>{t("contact.sms")}</a>
              </Button>
            ) : null}
          </div>
        </section>
        <section className="space-y-1 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{t("address.title")}</h2>
            {order.shippingValidationSkipped ? <Badge variant="warning" title={t("address.notCheckedHelp")}>{t("address.notChecked")}</Badge> : null}
          </div>
          {recipient ? <p>{recipient}</p> : null}
          <p className="text-muted-foreground">{address || t("address.none")}</p>
          {order.shippingPhone ? <p className="font-mono text-muted-foreground">{formatPhoneForDisplay(order.shippingPhone, getStoreRegion())}</p> : null}
          {order.shippingMethodName ? <p className="text-muted-foreground">{order.shippingMethodName}</p> : null}
        </section>
        {billingLines || order.billingSameAsShipping ? (
          <section className="space-y-1 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{t("billing.title")}</h2>
              {order.billingValidationSkipped ? <Badge variant="warning" title={t("address.notCheckedHelp")}>{t("address.notChecked")}</Badge> : null}
            </div>
            {billingLines ? (
              <>
                {billingRecipient ? <p>{billingRecipient}</p> : null}
                {billingLines.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
              </>
            ) : (
              <p className="text-muted-foreground">{t("billing.sameAsShipping")}</p>
            )}
          </section>
        ) : null}
        {actions.canViewFraudCheck ? (
          <section className="flex items-center justify-between gap-3 p-4">
            <div>
              <h2 className="font-semibold">{t("fraud.title")}</h2>
              {/* The courier history is looked up by phone: without one the check is skipped, with the reason. */}
              <p className="text-muted-foreground">{t(order.customerPhone ? "fraud.help" : "fraud.noPhone")}</p>
            </div>
            {order.customerPhone ? (
              <LazyFraudCheckIndicator phone={order.customerPhone} customerName={order.customerName} countryCode={order.shippingCountryCode} />
            ) : null}
          </section>
        ) : null}
        {order.appRiskChecks.length > 0 || released.length > 0 ? <AppRiskChecks checks={order.appRiskChecks} released={released} /> : null}
      </div>
      <Suspense fallback={null}>
        <OrderDetailsDialog order={order} open={editing} onOpenChange={setEditing} />
      </Suspense>
    </Card>
  );
}
