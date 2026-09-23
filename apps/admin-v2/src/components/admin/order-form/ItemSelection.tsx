import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { FormLabel } from "~/components/ui/form";
import { Plus } from "lucide-react";
import type { Product } from "./types";
import { useOrderForm } from "./OrderFormContext";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { OrderItemQuantityInput } from "./OrderItemQuantityInput";
import { discountedUnitPrice, orderItemVariantLabel } from "./order-item-presentation";
import {
  exceededStockMessage,
  remainingStockForNewOrderLine,
  remainingStockMessage,
  stagedVariantQuantity,
} from "./manual-order-stock";

interface ItemSelectionProps {
  selectedProduct: Product;
  selectedVariant: string;
  setSelectedVariant: (variantId: string) => void;
  quantity: number;
  setQuantity: (quantity: number) => void;
  handleAddItem: () => void;
}

/**
 * Variant + quantity row for a product with several variants (single-variant
 * products are added straight from search).
 */
export function ItemSelection({
  selectedProduct,
  selectedVariant,
  setSelectedVariant,
  quantity,
  setQuantity,
  handleAddItem,
}: ItemSelectionProps) {
  const { refs, form, isEdit } = useOrderForm();
  const { fmt } = useCurrency();
  const t = useMessages(orderFormMessages);
  const items = form.watch("items");
  const [isQuantityDraftValid, setIsQuantityDraftValid] = React.useState(true);
  const variants = selectedProduct.variants;
  const variant = variants.find((candidate) => candidate.id === selectedVariant);
  const remainingStock = isEdit ? null : remainingStockForNewOrderLine(variant, items);
  const alreadyStaged = variant ? stagedVariantQuantity(items, variant.id) : 0;
  const stockGuidanceId = "new-order-item-stock-guidance";

  return (
    <div className="grid items-start gap-4 sm:grid-cols-3">
      <div className="space-y-2">
        <FormLabel htmlFor="variant-select-trigger">{t("variant")}</FormLabel>
        <Select
          value={selectedVariant}
          disabled={variants.length === 0}
          onValueChange={(value) => {
            setSelectedVariant(value);
            setTimeout(() => document.getElementById("quantity-input")?.focus(), 0);
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
            <SelectValue
              placeholder={variants.length > 0 ? t("chooseVariant") : t("noVariantForSale")}
            />
          </SelectTrigger>
          <SelectContent>
            {variants.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                <div className="flex flex-col">
                  <span className="font-medium">{orderItemVariantLabel(option)}</span>
                  <span className="text-body text-muted-foreground">
                    {option.trackInventory === false
                      ? t("noStockLimit")
                      : t("inStock", { count: (option.stock ?? 0) - (option.reservedStock ?? 0) })}
                    {" · "}
                    {fmt(discountedUnitPrice(selectedProduct, option))}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <FormLabel htmlFor="quantity-input">{t("quantity")}</FormLabel>
        <OrderItemQuantityInput
          id="quantity-input"
          quantity={quantity}
          itemName={selectedProduct.name}
          onQuantityChange={setQuantity}
          onValidityChange={setIsQuantityDraftValid}
          onEnter={() => {
            refs.addItemButtonRef.current?.focus();
            // Let focus settle before adding.
            setTimeout(() => {
              handleAddItem();
            }, 100);
          }}
          maxQuantity={remainingStock ?? undefined}
          maximumExceededMessage={remainingStock === null
            ? undefined
            : exceededStockMessage(remainingStock)}
          describedBy={remainingStock === null ? undefined : stockGuidanceId}
          disabled={remainingStock === 0}
          className="w-full"
        />
        {remainingStock !== null ? (
          <p
            id={stockGuidanceId}
            className={remainingStock === 0
              ? "text-body text-destructive"
              : "text-body text-muted-foreground"}
          >
            {remainingStockMessage(remainingStock, alreadyStaged)}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        {/* Keeps the button on the fields' line under their labels. */}
        <FormLabel aria-hidden className="invisible hidden sm:block">{t("add")}</FormLabel>
        <Button
          type="button"
          onClick={handleAddItem}
          disabled={!variant || !isQuantityDraftValid || remainingStock === 0}
          className="w-full"
          ref={refs.addItemButtonRef}
        >
          <Plus className="h-4 w-4" />
          {t("add")}
        </Button>
      </div>
    </div>
  );
}
