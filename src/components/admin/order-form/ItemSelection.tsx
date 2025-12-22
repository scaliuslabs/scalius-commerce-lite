import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormLabel } from "@/components/ui/form";
import { Plus } from "lucide-react";
import type { Product } from "./types";
import { useOrderForm } from "./OrderFormContext";

interface ItemSelectionProps {
  selectedProduct: Product;
  selectedVariant: string;
  setSelectedVariant: (variantId: string) => void;
  quantity: number;
  setQuantity: (quantity: number) => void;
  handleAddItem: () => void;
  calculateDiscountedPrice: (product: Product, variantId: string | null) => string;
}

export function ItemSelection({
  selectedProduct,
  selectedVariant,
  setSelectedVariant,
  quantity,
  setQuantity,
  handleAddItem,
  calculateDiscountedPrice,
}: ItemSelectionProps) {
  const { refs } = useOrderForm();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 p-4 border rounded-md bg-muted/20 items-end">
      <div className="col-span-full mb-2">
        <h3 className="text-lg font-medium">{selectedProduct.name}</h3>
        {selectedProduct.discountPercentage ? (
          <div className="flex items-center gap-2 mt-1 text-sm">
            <span className="line-through text-muted-foreground">
              ৳{selectedProduct.price.toLocaleString()}
            </span>
            <span className="text-green-600 font-medium">
              ৳
              {parseFloat(
                calculateDiscountedPrice(selectedProduct, null)
              ).toLocaleString()}
            </span>
            <Badge variant="secondary">
              {selectedProduct.discountPercentage}% OFF
            </Badge>
          </div>
        ) : (
          <div className="mt-1 text-sm">
            ৳{selectedProduct.price.toLocaleString()}
          </div>
        )}
      </div>

      <div>
        <FormLabel htmlFor="variant-select-trigger" className="mb-2 block">
          Variant (Optional)
        </FormLabel>
        <Select
          value={selectedVariant}
          onValueChange={(value) => {
            setSelectedVariant(value === "none" ? "" : value);
            setTimeout(
              () => document.getElementById("quantity-input")?.focus(),
              0
            );
          }}
        >
          <SelectTrigger
            id="variant-select-trigger"
            className="w-full"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                document.getElementById("quantity-input")?.focus();
              }
            }}
          >
            <SelectValue placeholder="Select variant" />
          </SelectTrigger>
          <SelectContent className="max-h-[300px]">
            <SelectItem value="none">No variant (Main product)</SelectItem>
            {selectedProduct.variants
              .filter((variant) => variant.id)
              .map((variant) => {
                const variantLabel =
                  [
                    variant.size && `Size: ${variant.size}`,
                    variant.color && `Color: ${variant.color}`,
                  ]
                    .filter(Boolean)
                    .join(", ") ||
                  variant.sku ||
                  "Variant";

                return (
                  <SelectItem key={variant.id} value={variant.id}>
                    <div className="flex flex-col w-full">
                      <span className="font-medium">{variantLabel}</span>
                      <div className="flex justify-between text-xs text-muted-foreground mt-1 w-full">
                        <span>Stock: {variant.stock}</span>
                        <span className="ml-4">
                          {selectedProduct.discountPercentage ? (
                            <span className="text-green-600">
                              ৳
                              {parseFloat(
                                calculateDiscountedPrice(selectedProduct, variant.id)
                              ).toLocaleString()}
                            </span>
                          ) : (
                            <span>৳{variant.price.toLocaleString()}</span>
                          )}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
          </SelectContent>
        </Select>
      </div>

      <div>
        <FormLabel htmlFor="quantity-input" className="mb-2 block">
          Quantity
        </FormLabel>
        <Input
          id="quantity-input"
          type="number"
          min="1"
          value={quantity}
          onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              refs.addItemButtonRef.current?.focus();
              // A slight delay ensures the focus-then-click works reliably
              setTimeout(() => {
                handleAddItem();
              }, 100);
            }
          }}
          placeholder="Quantity"
          className="w-full"
        />
      </div>

      <div className="self-end">
        <Button
          type="button"
          onClick={handleAddItem}
          className="w-full"
          ref={refs.addItemButtonRef}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Item
        </Button>
      </div>
    </div>
  );
}