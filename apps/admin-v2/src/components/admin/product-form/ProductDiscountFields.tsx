import { useWatch, type UseFormReturn } from "react-hook-form";
import { FormField } from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PercentInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";
import { Field, FieldRow } from "~/components/ui/field";

/** A product with options that already carries a product-level discount: change or remove it here. */
export default function ProductDiscountFields({ form }: { form: UseFormReturn<ProductFormValues> }) {
  const t = useMessages(productMessages);
  const { code } = useCurrency();
  const discountType = useWatch({ control: form.control, name: "discountType" });
  return (
    <FieldRow>
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
        render={({ field, fieldState }) => (
          <Field label={t("discount")} error={fieldState.error?.message}>
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
              <PercentInput
                ref={field.ref}
                name={field.name}
                placeholder="0"
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
          </Field>
        )}
      />
      <p className="text-body text-muted-foreground @md:col-span-2">{t("variantDiscountHint")}</p>
    </FieldRow>
  );
}
