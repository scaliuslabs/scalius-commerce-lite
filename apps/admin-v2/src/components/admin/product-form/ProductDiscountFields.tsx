import { useWatch, type UseFormReturn } from "react-hook-form";
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { NumberInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";
import { Field } from "~/components/ui/field";

/** A product with options that already carries a product-level discount: change or remove it here. */
export default function ProductDiscountFields({ form }: { form: UseFormReturn<ProductFormValues> }) {
  const t = useMessages(productMessages);
  const { symbol, code } = useCurrency();
  const discountType = useWatch({ control: form.control, name: "discountType" });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        control={form.control}
        name="discountType"
        render={({ field, fieldState }) => (
          <Field label={t("discountType")} error={fieldState.error?.message}>
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
          </Field>
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
      <p className="text-body text-muted-foreground sm:col-span-2">{t("variantDiscountHint")}</p>
    </div>
  );
}
