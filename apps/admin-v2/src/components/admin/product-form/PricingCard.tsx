import { useState, type ChangeEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";

function numberField(onChange: (value: number) => void) {
  return (event: ChangeEvent<HTMLInputElement>) =>
    onChange(event.target.value === "" ? 0 : Number(event.target.value));
}

export function PricingCard({ form }: { form: UseFormReturn<ProductFormValues> }) {
  const t = useMessages(productMessages);
  const { symbol, fmt } = useCurrency();
  const [discountShown, setDiscountShown] = useState(false);
  const [rawPrice, discountType, rawPercentage, rawAmount] = useWatch({
    control: form.control,
    name: ["price", "discountType", "discountPercentage", "discountAmount"],
  });
  const price = Number(rawPrice ?? 0);
  const discountPercentage = Number(rawPercentage ?? 0);
  const discountAmount = Number(rawAmount ?? 0);
  const { errors } = form.formState;
  const discountOpen = discountShown || Boolean(errors.discountPercentage || errors.discountAmount);

  const rawDiscount = discountType === "flat" ? discountAmount : price * (discountPercentage / 100);
  const appliedDiscount = Math.min(Math.max(rawDiscount, 0), Math.max(price, 0));
  const hasDiscount = appliedDiscount > 0;

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
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  {...field}
                  value={field.value || ""}
                  onChange={numberField(field.onChange)}
                />
              </FormControl>
              {hasDiscount ? (
                <p className="text-body text-muted-foreground">
                  {t("customerPays", { amount: fmt(Math.max(price - appliedDiscount, 0)) })}
                </p>
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
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max={discountType === "flat" ? undefined : "100"}
                      step="0.01"
                      placeholder="0"
                      {...field}
                      value={field.value || ""}
                      onChange={numberField(field.onChange)}
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
                ? t("amountOff", { amount: fmt(discountAmount) })
                : t("percentOff", { percent: discountPercentage })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
