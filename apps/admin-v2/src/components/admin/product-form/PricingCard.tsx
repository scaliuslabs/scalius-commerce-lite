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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";

export function PricingCard({ form }: { form: UseFormReturn<ProductFormValues> }) {
  const t = useMessages(productMessages);
  const { symbol, fmt, salePrice } = useCurrency();
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pricing")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          control={form.control}
          name="price"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("priceLabel", { symbol })}</FormLabel>
              <FormControl>
                <NumberInput
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
        />

        {discountOpen ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="discountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("discountType")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      form.setValue(value === "flat" ? "discountPercentage" : "discountAmount", 0, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="percentage">{t("discountPercentage")}</SelectItem>
                      <SelectItem value="flat">{t("discountFixed")}</SelectItem>
                    </SelectContent>
                  </Select>
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
                    <NumberInput
                      ref={field.ref}
                      name={field.name}
                      placeholder="0"
                      value={field.value}
                      onValueChange={field.onChange}
                      onBlur={field.onBlur}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
