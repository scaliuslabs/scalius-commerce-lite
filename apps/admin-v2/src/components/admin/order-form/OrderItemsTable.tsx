import { Button } from "~/components/ui/button";
import { Trash2 } from "lucide-react";
import type { OrderItem, Product } from "./types";
import { useOrderForm } from "./OrderFormContext";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { orderItemVariantLabel } from "./order-item-presentation";
import { OrderItemQuantityInput } from "./OrderItemQuantityInput";
import {
  exceededStockMessage,
  remainingStockForNewOrderLine,
} from "./manual-order-stock";

type ProductVariant = Product["variants"][number];

export const orderLineQuantityId = (index: number) => `order-line-${index}-quantity`;

interface OrderItemsTableProps {
  resolvedVariantsById?: Record<string, ProductVariant>;
}

/**
 * The order's lines: product, variant, quantity, line total and remove. Line
 * totals are before the order discount, so they add up to the subtotal.
 */
export function OrderItemsTable({ resolvedVariantsById = {} }: OrderItemsTableProps) {
  const { form, products, isEdit, manualQuote } = useOrderForm();
  const { fmt } = useCurrency();
  const t = useMessages(orderFormMessages);
  const items = form.watch("items") as OrderItem[];

  const setItems = (next: OrderItem[]) =>
    form.setValue("items", next, { shouldDirty: true, shouldValidate: true });

  const handleQuantityChange = (index: number, quantity: number) => {
    const currentItems = [...form.getValues("items")];
    const currentItem = currentItems[index];
    if (!currentItem || currentItem.quantity === quantity) return;
    currentItems[index] = { ...currentItem, quantity };
    setItems(currentItems);
  };

  if (items.length === 0) {
    return (
      <div className="space-y-1 border-t pt-6 pb-2 text-center">
        <p className="text-body font-medium">{t("noItems")}</p>
        <p className="text-body text-muted-foreground">{t("noItemsHint")}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y border-t">
      {items.map((item, index) => {
        const product = products.find((candidate) => candidate.id === item.productId);
        const variant = item.variantId
          ? resolvedVariantsById[item.variantId]
            ?? product?.variants.find((candidate) => candidate.id === item.variantId)
          : undefined;
        const quotedLine = manualQuote.isCurrent
          ? manualQuote.data?.lines.find((line) =>
              line.index === index
              && line.productId === item.productId
              && line.variantId === item.variantId
              && line.quantity === item.quantity)
          : undefined;
        const maximumQuantity = isEdit
          ? null
          : remainingStockForNewOrderLine(variant, items, index);
        const name = item.name ?? product?.name ?? t("unknownProduct");
        const variantText = item.variantLabel !== undefined
          ? item.variantLabel
          : orderItemVariantLabel(variant);

        return (
          <li
            key={`${item.productId}-${item.variantId ?? "sku"}-${index}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
          >
            <div className="min-w-0 flex-1 basis-40">
              <p className="truncate text-body font-medium">{name}</p>
              <p className="truncate text-body text-muted-foreground">
                {[variantText, fmt(quotedLine?.unitPrice ?? item.price)].filter(Boolean).join(" · ")}
              </p>
            </div>
            <OrderItemQuantityInput
              id={orderLineQuantityId(index)}
              quantity={item.quantity}
              itemName={name}
              onQuantityChange={(quantity) => handleQuantityChange(index, quantity)}
              maxQuantity={maximumQuantity ?? undefined}
              maximumExceededMessage={maximumQuantity === null
                ? undefined
                : exceededStockMessage(maximumQuantity)}
            />
            <p className="min-w-20 text-right text-body font-medium tabular-nums">
              {fmt(quotedLine?.lineSubtotal ?? item.price * item.quantity)}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setItems(form.getValues("items").filter((_, i) => i !== index))}
              aria-label={t("remove", { name })}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
