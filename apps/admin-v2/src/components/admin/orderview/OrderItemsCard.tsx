import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package, ArrowRight, TicketPercent } from "lucide-react";
import type { Order, OrderItem } from "./types";
import { useCurrency } from "@/hooks/use-currency";
import { formatOrderAmount } from "./formatters";
import {
  formatSavedMinorAmount,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
  type SavedOrderMoneySummary,
} from "@/lib/order-tax-presentation";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";

interface OrderItemsCardProps {
  order: Order;
}

const OrderItemRow = ({
  item,
  symbol,
  savedSummary,
  hasPromotion,
}: {
  item: OrderItem;
  symbol: string;
  savedSummary: SavedOrderMoneySummary | null;
  hasPromotion: boolean;
}) => {
  const savedLine = resolveSavedOrderLineMoney(item, savedSummary);
  const unitPrice = savedLine && savedSummary
    ? formatSavedMinorAmount(savedLine.unitPriceMinor, savedSummary)
    : `${symbol}${formatOrderAmount(item.price)}`;
  const lineTotal = savedLine && savedSummary
    ? formatSavedMinorAmount(savedLine.totalMinor, savedSummary)
    : `${symbol}${formatOrderAmount(item.price * item.quantity)}`;

  return (
  <div
    key={item.id}
    className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/5"
  >
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
      {item.productImage ? (
        <img
          src={getOptimizedImageUrl(item.productImage, {
            width: 128,
            height: 128,
            quality: 80,
            fit: "contain",
          })}
          alt={item.productName?.toString() || ""}
          className="h-full w-full object-contain object-center"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Package className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
    </div>
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate font-medium text-foreground">
            {item.productName || "Unnamed Product"}
          </h3>
          {item.variantLabel && (
            <p className="text-xs text-muted-foreground">
              {item.variantLabel}
            </p>
          )}
          <Link
            to={`/admin/products/${item.productId}/edit` as string}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            View Product
            <ArrowRight className="h-3 w-3" />
          </Link>
          {savedLine && savedSummary && savedLine.discountMinor > 0 && (
            <p className="text-xs text-muted-foreground">
              {hasPromotion ? "Promotion share" : "Item discount"}: −{formatSavedMinorAmount(savedLine.discountMinor, savedSummary)}
            </p>
          )}
          {savedLine && savedSummary && savedLine.taxMinor > 0 && (
            <p className="text-xs text-muted-foreground">
              {savedSummary.taxLabel}{savedSummary.pricesIncludeTax ? " included" : " added"}: {formatSavedMinorAmount(savedLine.taxMinor, savedSummary)}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          {savedLine && <p className="text-xs text-muted-foreground">Line total</p>}
          <p className="font-medium text-foreground">
            {lineTotal}
          </p>
          <p className="text-xs text-muted-foreground">
            {unitPrice} × {item.quantity}
          </p>
        </div>
      </div>
    </div>
  </div>
  );
};

const SummaryRow = ({
  label,
  value,
  isDestructive = false,
}: {
  label: string;
  value: string;
  isDestructive?: boolean;
}) => (
  <div className="flex justify-between text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span
      className={`font-medium ${isDestructive ? "text-green-600 dark:text-green-400" : "text-foreground"}`}
    >
      {value}
    </span>
  </div>
);

export function OrderItemsCard({ order }: OrderItemsCardProps) {
  const { symbol } = useCurrency();
  const savedSummary = resolveSavedOrderMoneySummary(order);
  // totalAmount is the GRAND TOTAL (items + shipping - discount), computed server-side.
  // Reverse-engineer subtotal for display: subtotal = totalAmount - shipping + discount
  const subtotal = order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Package className="h-4 w-4" />
          Order Items ({order.items.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          {order.items.map((item) => (
            <OrderItemRow
              key={item.id}
              item={item}
              symbol={symbol}
              savedSummary={savedSummary}
              hasPromotion={Boolean(order.promotion)}
            />
          ))}
        </div>

        {/* Order Summary */}
        <div className="border-t border-border bg-muted/5 p-4">
          <div className="ml-auto w-full space-y-1.5 sm:w-80">
            {order.promotion ? (
              <div className="mb-3 flex items-start gap-2 rounded-lg border bg-background px-3 py-2.5 text-xs">
                <TicketPercent className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      to="/admin/promotions/$promotionId/edit"
                      params={{ promotionId: order.promotion.id }}
                      className="truncate font-medium underline-offset-4 hover:underline"
                    >
                      {order.promotion.name}
                    </Link>
                    {order.promotion.code ? (
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">
                        {order.promotion.code}
                      </code>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                    Saved promotion revision {order.promotion.revision}
                  </p>
                </div>
              </div>
            ) : null}
            {savedSummary ? (
              <>
                <SummaryRow label="Subtotal" value={formatSavedMinorAmount(savedSummary.subtotalMinor, savedSummary)} />
                <SummaryRow label="Shipping" value={formatSavedMinorAmount(savedSummary.shippingMinor, savedSummary)} />
                <SummaryRow
                  label="Discount"
                  value={`${savedSummary.discountMinor > 0 ? "−" : ""}${formatSavedMinorAmount(savedSummary.discountMinor, savedSummary)}`}
                  isDestructive
                />
                <SummaryRow
                  label={`${savedSummary.taxLabel}${savedSummary.pricesIncludeTax ? " (included)" : ""}`}
                  value={formatSavedMinorAmount(savedSummary.taxMinor, savedSummary)}
                />
                <div className="flex justify-between border-t border-border pt-1.5">
                  <span className="font-medium text-foreground">Total</span>
                  <span className="font-medium text-foreground">
                    {formatSavedMinorAmount(savedSummary.totalMinor, savedSummary)}
                  </span>
                </div>
                <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                  Amounts saved in {savedSummary.currencyCode} when this order was placed.
                  {savedSummary.pricesIncludeTax && ` ${savedSummary.taxLabel} is already included in the prices above.`}
                </p>
              </>
            ) : (
              <>
                <SummaryRow
                  label="Subtotal"
                  value={`${symbol}${formatOrderAmount(subtotal)}`}
                />
                {order.shippingCharge > 0 && (
              <SummaryRow
                label="Shipping"
                value={`${symbol}${formatOrderAmount(order.shippingCharge)}`}
              />
                )}
                {(order.discountAmount ?? 0) > 0 && (
              <SummaryRow
                label="Discount"
                value={`-${symbol}${formatOrderAmount(order.discountAmount)}`}
                isDestructive
              />
                )}
                <div className="flex justify-between border-t border-border pt-1.5">
                  <span className="font-medium text-foreground">Total</span>
                  <span className="font-medium text-foreground">
                    {symbol}{formatOrderAmount(order.totalAmount)}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
