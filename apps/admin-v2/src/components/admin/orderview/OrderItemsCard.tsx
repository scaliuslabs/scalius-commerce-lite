import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useCurrency } from "~/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import {
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import type { Order } from "./types";

/** The store's default tax label is ours to translate; a merchant's own label is shown as typed. */
export function taxLabelText(label: string, t: (key: "summary.tax") => string): string {
  return label.trim().toLowerCase() === "tax" ? t("summary.tax") : label;
}

/**
 * Lines at their full price (they add up to the subtotal); every discount,
 * delivery and tax is in the summary below, as in Shopify.
 */
export function OrderItemsCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const { fmt } = useCurrency();
  const saved = resolveSavedOrderMoneySummary(order);
  const money = (major: number) => (saved ? formatSavedMinorAmount(Math.round(major * 10 ** saved.decimalPlaces), saved) : fmt(major));
  const minor = (amount: number) => formatSavedMinorAmount(amount, saved!);
  const delivery = resolveDeliveryMethodPresentation(order, saved);
  // totalAmount is the grand total; the legacy subtotal is derived from it.
  const legacySubtotal = order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0);
  const hasDiscount = saved ? saved.discountMinor > 0 : (order.discountAmount ?? 0) > 0;
  const discounts: Array<{ label: string; value: string; detail?: ReactNode }> = order.discounts.length > 0
    ? order.discounts.map((discount) => ({
        label: discount.code ? t("summary.discountCode", { code: discount.code }) : t("summary.discount"),
        value: `−${money(discount.amount)}`,
        detail: (
          <Link to="/admin/discounts/$discountId" params={{ discountId: discount.promotionId }} className="text-link hover:underline">
            {discount.name}
          </Link>
        ),
      }))
    : hasDiscount
      // A manual order discount has no promotion behind it.
      ? [{ label: t("summary.discount"), value: `−${saved ? minor(saved.discountMinor) : fmt(order.discountAmount ?? 0)}` }]
      : [];

  const summary: Array<{ label: string; value: string; detail?: ReactNode }> = [
    { label: t("summary.subtotal"), value: saved ? minor(saved.subtotalMinor) : fmt(legacySubtotal) },
    { label: delivery.label, value: saved ? minor(saved.shippingMinor) : fmt(order.shippingCharge), detail: delivery.details },
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
            <div key={`${row.label}:${index}`} className="flex justify-between gap-4">
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
