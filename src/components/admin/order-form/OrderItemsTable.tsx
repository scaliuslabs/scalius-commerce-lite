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

export function OrderItemsTable() {
  const { form, products } = useOrderForm();
  
  // Directly get the items from the form state.
  // We'll use form.watch() to re-render the component when items change.
  const items = form.watch("items");

  const handleRemoveItem = (index: number) => {
    const currentItems = [...form.getValues("items")];
    currentItems.splice(index, 1);
    form.setValue("items", currentItems, { shouldDirty: true, shouldValidate: true });
    updateOrderItems(currentItems);
  };

  return (
    <div className="rounded-md border mt-6">
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
          {items.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-center py-10 text-muted-foreground"
              >
                <div className="flex flex-col items-center gap-3">
                  <div className="rounded-full bg-muted p-4">
                    <ShoppingBag className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">No items added yet</p>
                    <p className="text-sm">Search for products to add them to the order.</p>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            (items as OrderItem[]).map((item, index) => {
              const product = products.find((p) => p.id === item.productId);
              const variant = product?.variants.find(
                (v) => v.id === item.variantId
              );

              return (
                <TableRow key={`${item.productId}-${item.variantId}-${index}`}>
                  <TableCell className="font-medium">
                    {product?.name ?? "Unknown Product"}
                  </TableCell>
                  <TableCell>
                    {variant
                      ? [
                          variant.size && `Size: ${variant.size}`,
                          variant.color && `Color: ${variant.color}`,
                        ]
                          .filter(Boolean)
                          .join(", ") ||
                        (product?.variants.length ? "Variant" : "—")
                      : "—"}
                  </TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>৳{item.price.toLocaleString()}</TableCell>
                  <TableCell className="font-medium">
                    ৳{(item.price * item.quantity).toLocaleString()}
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
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}