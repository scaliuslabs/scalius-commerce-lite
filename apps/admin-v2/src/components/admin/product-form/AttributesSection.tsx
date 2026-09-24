import type { UseFormReturn } from "react-hook-form";
import { FormField, FormItem } from "@/components/ui/form";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { AttributeManager } from "./AttributeManager";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

export function AttributesSection({ form, defaultOpen }: { form: UseFormReturn<ProductFormValues>; defaultOpen: boolean }) {
  const t = useMessages(productMessages);
  const rowErrors = form.formState.errors.attributes;
  // Rows a check (Save, or a re-check after an error) found without a value.
  const missingValueRows = new Set(
    Array.isArray(rowErrors) ? rowErrors.flatMap((row, index) => (row?.value ? [index] : [])) : [],
  );
  return (
    <CollapsibleCard title={t("attributes")} description={t("attributesHint")} defaultOpen={defaultOpen || missingValueRows.size > 0}>
      <FormField
        control={form.control}
        name="attributes"
        render={({ field }) => (
          <FormItem>
            <AttributeManager
              initialAttributes={field.value || []}
              missingValueRows={missingValueRows}
              onAttributesChange={(next) =>
                // A just-added attribute has no value yet: only re-check once a check has failed.
                form.setValue("attributes", next, { shouldDirty: true, shouldValidate: Boolean(rowErrors) })
              }
            />
          </FormItem>
        )}
      />
    </CollapsibleCard>
  );
}
