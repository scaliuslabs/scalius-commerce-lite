import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Trash, ShoppingBag } from "lucide-react";
import type { OrderItem } from "./types";
import { useOrderForm } from "./OrderFormContext";
import { updateOrderItems } from "@/store/orderStore";
import { useCurrency } from "@/hooks/use-currency";
import type { Product } from "./types";
import { orderItemVariantLabel } from "./order-item-presentation";

type ProductVariant = Product["variants"][number];

interface OrderItemsTableProps {
  resolvedProductsById?: Record<string, Product>;
  resolvedVariantsById?: Record<string, ProductVariant>;
}

export function OrderItemsTable({
  resolvedProductsById = {},
  resolvedVariantsById = {},
}: OrderItemsTableProps) {
  const { form, products, isEdit, manualQuote } = useOrderForm();
  const { symbol } = useCurrency();

  // Directly get the items from the form state.
  // We'll use form.watch() to re-render the component when items change.
  const items = form.watch("items");

  const rows = (items as OrderItem[]).map((item, index) => {
    const product = resolvedProductsById[item.productId]
      ?? products.find((candidate) => candidate.id === item.productId);
    const variant = item.variantId
      ? resolvedVariantsById[item.variantId] ?? product?.variants.find(
          (candidate) => candidate.id === item.variantId,
        )
      : undefined;
    const quotedLine = !isEdit && manualQuote.isCurrent
      ? manualQuote.data?.lines.find((line) =>
          line.index === index
          && line.productId === item.productId
          && line.variantId === item.variantId
          && line.quantity === item.quantity)
      : undefined;

    return {
      item,
      index,
      product,
      variant,
      unitPrice: quotedLine?.unitPrice ?? item.price,
      lineSubtotal: quotedLine?.lineSubtotal ?? item.price * item.quantity,
    };
  });

  const handleRemoveItem = (index: number) => {
    const currentItems = [...form.getValues("items")];
    currentItems.splice(index, 1);
    form.setValue("items", currentItems, { shouldDirty: true, shouldValidate: true });
    updateOrderItems(currentItems);
  };

  const emptyState = (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-muted-foreground">
      <div className="rounded-full bg-muted p-3">
        <ShoppingBag className="h-6 w-6" />
      </div>
      <div>
        <p className="font-medium">No items added yet</p>
        <p className="text-sm">Search for a product to begin.</p>
      </div>
    </div>
  );

  return (
    <div className="mt-3">
      <div className="hidden overflow-hidden rounded-md border md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Variant</TableHead>
            <TableHead>Quantity</TableHead>
            <TableHead>Unit Price</TableHead>
            <TableHead>Total</TableHead>
            <TableHead className="w-[70px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="p-0"
              >
                {emptyState}
              </TableCell>
            </TableRow>
          ) : (
            rows.map(({ item, index, product, variant, unitPrice, lineSubtotal }) => (
                <TableRow key={`${item.productId}-${item.variantId ?? "sku"}-${index}`}>
                  <TableCell className="font-medium">
                    {product?.name ?? "Unknown Product"}
                  </TableCell>
                  <TableCell>
                    {orderItemVariantLabel(variant)}
                  </TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>{symbol}{unitPrice.toLocaleString()}</TableCell>
                  <TableCell className="font-medium">
                    {symbol}{lineSubtotal.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemoveItem(index)}
                      className="text-destructive hover:text-destructive/90 hover:bg-destructive/10"
                      aria-label={`Remove ${product?.name ?? "item"}`}
                    >
                      <Trash className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>

      <div className="overflow-hidden rounded-md border md:hidden">
        {rows.length === 0 ? emptyState : rows.map(({
          item,
          index,
          product,
          variant,
          unitPrice,
          lineSubtotal,
        }) => (
          <div
            key={`${item.productId}-${item.variantId ?? "sku"}-${index}`}
            className="border-b p-3 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {product?.name ?? "Unknown Product"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {orderItemVariantLabel(variant)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveItem(index)}
                className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive/90"
                aria-label={`Remove ${product?.name ?? "item"}`}
              >
                <Trash className="h-4 w-4" />
              </Button>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
              <div>
                <dt className="text-[11px] text-muted-foreground">Qty</dt>
                <dd>{item.quantity}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-muted-foreground">Unit</dt>
                <dd>{symbol}{unitPrice.toLocaleString()}</dd>
              </div>
              <div className="text-right">
                <dt className="text-[11px] text-muted-foreground">Total</dt>
                <dd className="font-medium">{symbol}{lineSubtotal.toLocaleString()}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
