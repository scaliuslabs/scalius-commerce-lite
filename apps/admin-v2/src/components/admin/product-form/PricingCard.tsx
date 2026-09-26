import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { useProductKindRules } from "./product-kind-rules";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";

/**
 * A product without options has one price. With options each variant has its
 * own, so the card shows their range instead of a price nobody pays (Shopify
 * hides it too); a product discount still applies to variants without one.
 */
export function PricingCard({ form, variantPrices }: {
  form: UseFormReturn<ProductFormValues>;
  variantPrices: VariantPriceRange | null;
}) {
  const t = useMessages(productMessages);
  const { showDiscount } = useProductKindRules();
  const { symbol, code, fmt, salePrice } = useCurrency();
  const [discountShown, setDiscountShown] = useState(false);
  const [price, discountType, discountPercentage, discountAmount] = useWatch({
    control: form.control,
    name: ["price", "discountType", "discountPercentage", "discountAmount"],
  });
  const { errors } = form.formState;
  const discountOpen = discountShown || Boolean(errors.discountPercentage || errors.discountAmount);
  const validPrice = Number.isFinite(price) ? price ?? 0 : 0;
  const sale = salePrice(validPrice, { discountType, discountPercentage, discountAmount });
  const hasDiscount = sale !== null;
  const discountHint = variantPrices ? <p className="text-body text-muted-foreground sm:col-span-2">{t("variantDiscountHint")}</p> : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pricing")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {variantPrices ? (
          <div className="space-y-1">
            <p className="text-body font-medium">{t("priceLabel", { symbol })}</p>
            <p className="text-body tabular-nums">
              {variantPrices.min === variantPrices.max
                ? fmt(variantPrices.min)
                : `${fmt(variantPrices.min)}–${fmt(variantPrices.max)}`}
            </p>
            <p className="text-body text-muted-foreground">{t("variantPricesHint")}</p>
          </div>
        ) : <FormField
          control={form.control}
          name="price"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("priceLabel", { symbol })}</FormLabel>
              <FormControl>
                <MoneyInput
                  currencyCode={code}
                  ref={field.ref}
                  name={field.name}
                  placeholder="0.00"
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              </FormControl>
              {hasDiscount ? (
                <p className="text-body text-muted-foreground">{t("customerPays", { amount: fmt(sale) })}</p>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />}

        {/* A gift card is worth its price: no discount (the product kind rules). */}
        {!showDiscount ? null : discountOpen ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="discountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("discountType")}</FormLabel>
                  <FormControl>
                    <SearchableSelect
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        form.setValue(value === "flat" ? "discountPercentage" : "discountAmount", 0, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                      }}
                      triggerClassName="w-full"
                      triggerRef={field.ref}
                      onBlur={field.onBlur}
                      options={[{ value: "percentage", label: t("discountPercentage") }, { value: "flat", label: t("discountFixed") }]}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              key={discountType}
              control={form.control}
              name={discountType === "flat" ? "discountAmount" : "discountPercentage"}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {discountType === "flat" ? t("discountAmountLabel", { symbol }) : t("discountPercentLabel")}
                  </FormLabel>
                  <FormControl>
                    {/* A flat discount is money (whole taka in BDT); a percentage is not. */}
                    {discountType === "flat" ? (
                      <MoneyInput
                        currencyCode={code}
                        ref={field.ref}
                        name={field.name}
                        placeholder="0"
                        value={field.value}
                        onValueChange={field.onChange}
                        onBlur={field.onBlur}
                      />
                    ) : (
                      <NumberInput
                        ref={field.ref}
                        name={field.name}
                        placeholder="0"
                        value={field.value}
                        onValueChange={field.onChange}
                        onBlur={field.onBlur}
                      />
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {discountHint}
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setDiscountShown(true)}>
            {!hasDiscount
              ? t("addDiscount")
              : discountType === "flat"
                ? t("amountOff", { amount: fmt(discountAmount ?? 0) })
                : t("percentOff", { percent: discountPercentage ?? 0 })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
