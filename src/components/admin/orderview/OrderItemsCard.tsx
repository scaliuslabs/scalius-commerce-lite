import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package, ArrowRight } from "lucide-react";
import type { Order, OrderItem } from "./types";

interface OrderItemsCardProps {
  order: Order;
}

const OrderItemRow = ({ item }: { item: OrderItem }) => (
  <div
    key={item.id}
    className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/5"
  >
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
      {item.productImage ? (
        <img
          src={item.productImage}
          alt={item.productName?.toString() || ""}
          className="h-full w-full object-cover object-center"
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
          {(item.variantSize || item.variantColor) && (
            <p className="text-xs text-muted-foreground">
              {item.variantSize && `Size: ${item.variantSize}`}
              {item.variantSize && item.variantColor && " / "}
              {item.variantColor && `Color: ${item.variantColor}`}
            </p>
          )}
          <a
            href={`/admin/products/${item.productId}/edit`}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            View Product
            <ArrowRight className="h-3 w-3" />
          </a>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-medium text-foreground">
            ৳{(item.price * item.quantity).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            ৳{item.price.toLocaleString()} × {item.quantity}
          </p>
        </div>
      </div>
    </div>
  </div>
);

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
  const grandTotal =
    order.totalAmount + order.shippingCharge - (order.discountAmount ?? 0);

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
            <OrderItemRow key={item.id} item={item} />
          ))}
        </div>

        {/* Order Summary */}
        <div className="border-t border-border bg-muted/5 p-4">
          <div className="ml-auto w-full space-y-1.5 sm:w-72">
            <SummaryRow
              label="Subtotal"
              value={`৳${order.totalAmount.toLocaleString()}`}
            />
            {order.shippingCharge > 0 && (
              <SummaryRow
                label="Shipping"
                value={`৳${order.shippingCharge.toLocaleString()}`}
              />
            )}
            {(order.discountAmount ?? 0) > 0 && (
              <SummaryRow
                label="Discount"
                value={`-৳${order.discountAmount?.toLocaleString()}`}
                isDestructive
              />
            )}
            <div className="flex justify-between border-t border-border pt-1.5">
              <span className="font-medium text-foreground">Total</span>
              <span className="font-medium text-foreground">
                ৳{grandTotal.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
