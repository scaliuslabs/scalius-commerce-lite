import type { UseFormReturn } from "react-hook-form";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { AttributeManager } from "./AttributeManager";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

export function AttributesSection({ form, defaultOpen }: { form: UseFormReturn<ProductFormValues>; defaultOpen: boolean }) {
  const t = useMessages(productMessages);
  return (
    <CollapsibleCard title={t("attributes")} description={t("attributesHint")} defaultOpen={defaultOpen}>
      <FormField
        control={form.control}
        name="attributes"
        render={({ field }) => (
          <FormItem>
            <AttributeManager
              initialAttributes={field.value || []}
              onAttributesChange={(next) =>
                form.setValue("attributes", next, { shouldDirty: true, shouldValidate: true })
              }
            />
            <FormMessage />
          </FormItem>
        )}
      />
    </CollapsibleCard>
  );
}
