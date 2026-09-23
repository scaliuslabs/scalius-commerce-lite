import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import {
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { resolveDeliveryMethodPresentation } from "~/lib/delivery-method-presentation";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import type { Order } from "./types";

export function OrderItemsCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const { fmt } = useCurrency();
  const saved = resolveSavedOrderMoneySummary(order);
  const minor = (amount: number) => formatSavedMinorAmount(amount, saved!);
  const delivery = resolveDeliveryMethodPresentation(order, saved);
  // totalAmount is the grand total; the legacy subtotal is derived from it.
  const legacySubtotal = order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0);
  const discount = saved ? saved.discountMinor : order.discountAmount ?? 0;

  const promotion = order.promotion ? (
    <Link
      to="/admin/discounts/$discountId"
      params={{ discountId: order.promotion.id }}
      className="text-primary hover:underline"
    >
      {order.promotion.code ?? order.promotion.name}
    </Link>
  ) : null;
  const summary: Array<{ label: string; value: string; detail?: ReactNode }> = saved
    ? [
        { label: t("summary.subtotal"), value: minor(saved.subtotalMinor) },
        { label: delivery.label, value: minor(saved.shippingMinor), detail: delivery.details },
        { label: t("summary.discount"), value: discount > 0 ? `−${minor(discount)}` : minor(0), detail: promotion },
        {
          label: saved.pricesIncludeTax ? t("summary.taxIncluded", { label: saved.taxLabel }) : saved.taxLabel,
          value: minor(saved.taxMinor),
        },
      ]
    : [
        { label: t("summary.subtotal"), value: fmt(legacySubtotal) },
        { label: delivery.label, value: fmt(order.shippingCharge), detail: delivery.details },
        ...(discount > 0
          ? [{ label: t("summary.discount"), value: `−${fmt(discount)}`, detail: promotion }]
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
                  <p className="text-muted-foreground">
                    {line ? minor(line.unitPriceMinor) : fmt(item.price)} × {item.quantity}
                  </p>
                  {line && line.discountMinor > 0 ? (
                    <p className="text-muted-foreground">{t("items.lineDiscount", { amount: minor(line.discountMinor) })}</p>
                  ) : null}
                  {line && line.taxMinor > 0 ? (
                    <p className="text-muted-foreground">{saved!.taxLabel}: {minor(line.taxMinor)}</p>
                  ) : null}
                </div>
                <p className="shrink-0 font-medium">
                  {line ? minor(line.totalMinor) : fmt(item.price * item.quantity)}
                </p>
              </li>
            );
          })}
        </ul>
        <dl className="space-y-1.5 border-t px-6 py-4 text-body">
          {summary.map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
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
