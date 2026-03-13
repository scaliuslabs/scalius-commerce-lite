// src/components/admin/product-form/AttributesSection.tsx
import type { UseFormReturn } from "react-hook-form";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { AttributeManager } from "./AttributeManager";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

interface AttributesSectionProps {
  form: UseFormReturn<ProductFormValues>;
}

export function AttributesSection({ form }: AttributesSectionProps) {
  return (
    <CollapsibleCard
      title="Product Attributes"
      description="Add attributes like brand, warranty, or material"
      defaultOpen={false}
    >
      <FormField
        control={form.control}
        name="attributes"
        render={({ field }) => (
          <FormItem>
            <AttributeManager
              initialAttributes={field.value || []}
              onAttributesChange={(newAttributes) => {
                form.setValue("attributes", newAttributes, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
            />
            <FormMessage />
          </FormItem>
        )}
      />
    </CollapsibleCard>
  );
}
