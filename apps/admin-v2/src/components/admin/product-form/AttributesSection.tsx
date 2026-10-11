import { lazy, Suspense } from "react";
import type { UseFormReturn } from "react-hook-form";
import { FormField } from "@/components/ui/form";
import { LoadingFallback } from "@/components/admin/shared/LoadingFallback";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";
import { Field } from "~/components/ui/field";

const AttributeManager = lazy(() => import("./AttributeManager").then((module) => ({ default: module.AttributeManager })));

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
          <Field>
            <Suspense fallback={<LoadingFallback height="h-36" />}>
              <AttributeManager
                initialAttributes={field.value || []}
                missingValueRows={missingValueRows}
                onAttributesChange={(next) =>
                  // A just-added attribute has no value yet: only re-check once a check has failed.
                  form.setValue("attributes", next, { shouldDirty: true, shouldValidate: Boolean(rowErrors) })
                }
              />
            </Suspense>
          </Field>
        )}
      />
    </CollapsibleCard>
  );
}
