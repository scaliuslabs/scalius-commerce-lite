// src/components/admin/product-form/AdditionalInfoSection.tsx
import type { UseFormReturn } from "react-hook-form";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import {
  AdditionalInfoManager,
  type RichContentItem,
} from "./AdditionalInfoManager";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

interface AdditionalInfoSectionProps {
  form: UseFormReturn<ProductFormValues>;
}

export function AdditionalInfoSection({ form }: AdditionalInfoSectionProps) {
  return (
    <CollapsibleCard
      title="Additional Information"
      description="Add sections like specifications or usage guides"
      defaultOpen={false}
    >
      <FormField
        control={form.control}
        name="additionalInfo"
        render={({ field }) => (
          <FormItem>
            <AdditionalInfoManager
              initialContent={(field.value as RichContentItem[]) || []}
              onContentChange={(newContent) => {
                field.onChange(newContent);
              }}
            />
            <FormMessage />
          </FormItem>
        )}
      />
    </CollapsibleCard>
  );
}
