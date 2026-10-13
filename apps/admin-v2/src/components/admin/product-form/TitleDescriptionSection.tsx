import { lazy, Suspense } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { RichContent } from "@/components/ui/rich-content";
import { LoadingFallback } from "@/components/admin/shared/LoadingFallback";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { productContentSummaryMessages } from "~/i18n/product-content-summary";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";
import { richTextOrNull } from "~/lib/rich-text-value";
import { Field, ReadOnlyValue } from "~/components/ui/field";

const AdditionalInfoManager = lazy(() =>
  import("./AdditionalInfoManager").then((module) => ({
    default: module.AdditionalInfoManager,
  })),
);

interface SectionProps {
  form: UseFormReturn<ProductFormValues>;
  /** Viewers see saved rich text instead of an editor. */
  readOnly: boolean;
}

export function TitleDescriptionSection({ form, readOnly }: SectionProps) {
  const t = useMessages(productMessages);
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field, fieldState }) => readOnly ? (
            <ReadOnlyValue label={t("title")} value={field.value} />
          ) : (
            <Field label={t("title")} error={fieldState.error?.message}>
              <Input placeholder={t("titlePlaceholder")} {...field} />
            </Field>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field, fieldState }) => (
            <Field label={t("description")} error={fieldState.error?.message}>
              {readOnly ? (
                <RichContent content={field.value ?? ""} variant="compact" />
              ) : (
                <DeferredTiptapEditor
                  content={field.value || ""}
                  onChange={(html) => field.onChange(richTextOrNull(html))}
                  ariaLabel={t("description")}
                  compact
                />
              )}
            </Field>
          )}
        />
      </CardContent>
    </Card>
  );
}

/**
 * A new product's tabs and sections on its page, such as a size guide or care
 * (a saved product edits them in the same-named "Product page content" card):
 * the same title and help, and closed it says how many there are.
 */
export function AdditionalSectionsCard({ form, readOnly }: SectionProps) {
  const m = useMessages(productContentSummaryMessages);
  const sections = useWatch({ control: form.control, name: "additionalInfo" }) ?? [];
  if (readOnly && sections.length === 0) return null;

  return (
    <CollapsibleCard
      title={m("content")}
      description={m("contentHelp")}
      summary={(
        <p className="text-body text-muted-foreground">
          {sections.length > 0 ? m("blockCount", { count: sections.length }) : m("noBlocks")}
        </p>
      )}
      defaultOpen={readOnly || sections.length > 0}
    >
      {readOnly ? (
        sections.map((section) => (
          <div key={section.id} className="space-y-1">
            <h4 className="text-body font-medium">{section.title}</h4>
            <RichContent content={section.content} variant="compact" />
          </div>
        ))
      ) : (
        <Suspense fallback={<LoadingFallback height="h-36" />}>
          <FormField
            control={form.control}
            name="additionalInfo"
            render={({ field, fieldState }) => (
              <Field error={fieldState.error?.message}>
                <AdditionalInfoManager initialContent={field.value ?? []} onContentChange={field.onChange} />
              </Field>
            )}
          />
        </Suspense>
      )}
    </CollapsibleCard>
  );
}
