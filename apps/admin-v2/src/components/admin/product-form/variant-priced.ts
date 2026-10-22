import React from "react";
import type { Path, PathValue, UseFormReturn } from "react-hook-form";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";

/** The product's own price: its base price and discount, which read as the merchant's price and compare-at price. */
export type ProductPriceFields = Pick<ProductFormValues, "price" | "discountType" | "discountPercentage" | "discountAmount">;

const PRICE_FIELDS = ["price", "discountType", "discountPercentage", "discountAmount"] as const;

const pick = (values: Partial<ProductFormValues> | undefined): ProductPriceFields => ({
  price: values?.price ?? null,
  discountType: values?.discountType ?? "percentage",
  discountPercentage: values?.discountPercentage ?? 0,
  discountAmount: values?.discountAmount ?? 0,
});

/**
 * Sets a value the page derives as the loaded one: no change to save.
 * react-hook-form resets registered fields only, and the discount fields and
 * `variantPriced` have no input of their own (the Pricing card writes them
 * with `setValue`), so the field is registered first. Without that the reset
 * did nothing: the product kept its discount under options (buyer QA N1).
 */
function settle<K extends Path<ProductFormValues>>(form: UseFormReturn<ProductFormValues>, name: K, value: PathValue<ProductFormValues, K>) {
  form.register(name);
  form.resetField(name, { defaultValue: value });
}

/**
 * With options the variants carry the prices: the product price follows the
 * cheapest one, as the server keeps it, and the product keeps no discount
 * (each variant has its own compare-at price; the server refuses one).
 *
 * Returns the product's price fields as the merchant entered them before it
 * had options, or null while it has none. New variants start from that pair:
 * the derived price already took the discount once, so seeding from it took
 * the discount again for every value added. When the last option goes, the
 * product gets the entered pair back.
 */
export function useVariantPricedProduct(
  form: UseFormReturn<ProductFormValues>,
  variantPrices: VariantPriceRange | null,
): ProductPriceFields | null {
  const entered = React.useRef<{ values: ProductPriceFields; defaults: ProductPriceFields } | null>(null);
  const [seed, setSeed] = React.useState<ProductPriceFields | null>(null);
  React.useEffect(() => {
    settle(form, "variantPriced", variantPrices !== null);
    if (variantPrices) {
      if (!entered.current) {
        entered.current = { values: pick(form.getValues()), defaults: pick(form.formState.defaultValues as Partial<ProductFormValues>) };
        setSeed(entered.current.values);
      }
      settle(form, "price", variantPrices.min);
      settle(form, "discountType", "percentage");
      settle(form, "discountPercentage", 0);
      settle(form, "discountAmount", 0);
      return;
    }
    if (!entered.current) return;
    const { values, defaults } = entered.current;
    entered.current = null;
    setSeed(null);
    for (const name of PRICE_FIELDS) {
      settle(form, name, defaults[name] as never);
      form.setValue(name, values[name] as never, { shouldDirty: true });
    }
  }, [form, variantPrices]);
  return seed;
}
