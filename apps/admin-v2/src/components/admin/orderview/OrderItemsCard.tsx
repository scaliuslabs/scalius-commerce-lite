import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useCurrency } from "~/hooks/use-currency";
import { useHydrated } from "~/hooks/use-hydrated";
import { orderReturnsQueryOptions } from "~/lib/api-query-options/orders";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import type { OrderReturnDto } from "~/lib/order-return-workflow";
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import {
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import { summarizeOrderDiscounts } from "~/lib/order-discount-summary";
import { mediaImageUrl } from "@scalius/shared/media-variants";
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
 * Lines at their full price (they add up to the subtotal); every discount,
 * delivery and tax is in the summary below, as in Shopify.
 */
export function OrderItemsCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const { fmt } = useCurrency();
  const hydrated = useHydrated();
  // The Returns card reads the same query; this only reuses it.
  const returnsQuery = useQuery({ ...orderReturnsQueryOptions(order.id), enabled: hydrated, staleTime: ORDER_DETAIL_PREFETCH_STALE_MS });
  const returned = useMemo(() => returnedQuantities(returnsQuery.data?.returns ?? []), [returnsQuery.data]);
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

  const summary: SummaryRow[] = [
    { label: t("summary.subtotal"), value: saved ? minor(saved.subtotalMinor) : fmt(legacySubtotal) },
    {
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
    },
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
        <CardTitle>{t("items.title", { count: order.items.length })}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {order.items.map((item) => {
            const line = resolveSavedOrderLineMoney(item, saved);
            return (
              <li key={item.id} className="flex items-start gap-3 px-6 py-3 text-body">
                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                  {item.productImage ? (
                    <img
                      src={mediaImageUrl(item.productImage, 128)}
                      alt=""
                      className="size-full object-contain"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <Package className="size-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1 break-words">
                  <Link
                    to="/admin/products/$productId/edit"
                    params={{ productId: item.productId }}
                    className="font-medium hover:underline"
                  >
                    {item.productName || t("items.unnamed")}
                  </Link>
                  {item.variantLabel ? <p className="text-muted-foreground">{item.variantLabel}</p> : null}
                  <p className="text-muted-foreground tabular-nums">
                    {line ? minor(line.unitPriceMinor) : fmt(item.price)} × {formatNumber(item.quantity)}
                  </p>
                  {returned.get(item.id) ? <p className="text-muted-foreground">{t("items.returned", { count: returned.get(item.id)! })}</p> : null}
                </div>
                <p className="shrink-0 font-medium tabular-nums">
                  {line ? minor(line.grossSubtotalMinor) : fmt(item.price * item.quantity)}
                </p>
              </li>
            );
          })}
        </ul>
        <dl className="space-y-1.5 border-t px-6 py-4 text-body tabular-nums">
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
