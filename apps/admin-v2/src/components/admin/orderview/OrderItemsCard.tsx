import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useCurrency } from "~/hooks/use-currency";
import type { OrderReturnDto } from "~/lib/order-return-workflow";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import {
  formatSavedMinorAmount,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import { summarizeOrderDiscounts } from "~/lib/order-discount-summary";
import type { Order } from "./types";

/** The store's default tax label is ours to translate; a merchant's own label is shown as typed. */
export function taxLabelText(label: string, t: (key: "summary.tax") => string): string {
  return label.trim().toLowerCase() === "tax" ? t("summary.tax") : label;
}

type SummaryRow = { label: ReactNode; value: ReactNode; detail?: ReactNode };

/** Units of each order line that came back, from the order's returns. */
export function returnedQuantities(returns: readonly Pick<OrderReturnDto, "lines">[]): Map<string, number> {
  const returned = new Map<string, number>();
  for (const orderReturn of returns) {
    for (const line of orderReturn.lines) {
      if (line.receivedQuantity > 0) returned.set(line.orderItemId, (returned.get(line.orderItemId) ?? 0) + line.receivedQuantity);
    }
  }
  return returned;
}

/**
 * The order's money, as in Shopify: the lines (on the fulfilment cards) at
 * their full price add up to the subtotal; every discount, the delivery and
 * the tax are here.
 */
export function OrderSummaryCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const { fmt } = useCurrency();
  const saved = resolveSavedOrderMoneySummary(order);
  const decimals = saved?.decimalPlaces ?? 2;
  const minor = (amount: number) => (saved ? formatSavedMinorAmount(amount, saved) : fmt(amount / 10 ** decimals));
  // A saving on delivery reads on the delivery line itself, so its details don't repeat a waiver.
  const delivery = resolveDeliveryMethodPresentation({ ...order, shippingFeeWaived: false }, saved);
  // totalAmount is the grand total; the legacy subtotal is derived from it.
  const legacySubtotal = order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0);
  const discountSummary = summarizeOrderDiscounts({
    discounts: order.discounts,
    shippingMinor: saved ? saved.shippingMinor : Math.round(order.shippingCharge * 10 ** decimals),
    discountMinor: saved ? saved.discountMinor : Math.round((order.discountAmount ?? 0) * 10 ** decimals),
    decimalPlaces: decimals,
    waivedFeeMinor: order.shippingFeeWaived === true ? Number(order.shippingMethodBaseAmountMinor) || null : null,
  });
  const deliveryCharged = discountSummary.deliveryChargedMinor === 0 && discountSummary.deliveryStruckMinor !== null
    ? t("delivery.free")
    : minor(discountSummary.deliveryChargedMinor);
  const deliveryCodes = discountSummary.deliveryDiscountNames.length > 0
    ? ` (${discountSummary.deliveryDiscountNames.join(", ")})`
    : "";
  // One line per discount on the items: "Discount · Title (CODE)", the name linking to it.
  const discounts: SummaryRow[] = [
    ...discountSummary.itemDiscounts.map(({ discount, name, amountMinor }) => ({
      label: (
        <>
          {t("summary.discount")} ·{" "}
          <Link to="/admin/discounts/$discountId" params={{ discountId: discount.promotionId }} className="text-link hover:underline">
            {name}
          </Link>
        </>
      ),
      value: `−${minor(amountMinor)}`,
    })),
    // A manual order discount has no promotion behind it.
    ...(discountSummary.otherDiscountMinor > 0
      ? [{ label: t("summary.discount"), value: `−${minor(discountSummary.otherDiscountMinor)}` }]
      : []),
  ];

  const noDelivery = order.requiresShipping === false && order.shippingMethodKind == null
    && discountSummary.deliveryChargedMinor === 0;
  const summary: SummaryRow[] = [
    { label: t("summary.subtotal"), value: saved ? minor(saved.subtotalMinor) : fmt(legacySubtotal) },
    // Nothing physical was bought (a service): no delivery line at all.
    ...(noDelivery ? [] : [{
      label: delivery.label,
      value: (
        <>
          {discountSummary.deliveryStruckMinor !== null
            ? <><s className="text-muted-foreground">{minor(discountSummary.deliveryStruckMinor)}</s>{" "}</>
            : null}
          {deliveryCharged}{deliveryCodes}
        </>
      ),
      detail: delivery.details,
    }]),
    ...discounts,
    ...(saved && saved.taxMinor > 0
      ? [{
          label: saved.pricesIncludeTax
            ? t("summary.taxIncluded", { label: taxLabelText(saved.taxLabel, t) })
            : taxLabelText(saved.taxLabel, t),
          value: minor(saved.taxMinor),
        }]
      : []),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("summary.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1.5 text-body tabular-nums">
          {summary.map((row, index) => (
            <div key={index} className="flex justify-between gap-4">
              <dt className="min-w-0 text-muted-foreground">
                {row.label}
                {row.detail ? <span className="block">{row.detail}</span> : null}
              </dt>
              <dd className="shrink-0">{row.value}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-t pt-2 font-semibold">
            <dt>{t("summary.total")}</dt>
            <dd>{saved ? minor(saved.totalMinor) : fmt(order.totalAmount)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
