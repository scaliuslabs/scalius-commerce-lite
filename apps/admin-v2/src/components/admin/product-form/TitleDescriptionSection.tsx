import { lazy, Suspense } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { RichContent } from "@/components/ui/rich-content";
import { LoadingFallback } from "@/components/admin/shared/LoadingFallback";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

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
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("title")}</FormLabel>
              <FormControl>
                <Input placeholder={t("titlePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("description")}</FormLabel>
              {readOnly ? (
                <RichContent content={field.value ?? ""} variant="compact" />
              ) : (
                <FormControl>
                  <DeferredTiptapEditor
                    content={field.value || ""}
                    onChange={field.onChange}
                    ariaLabel={t("description")}
                    compact
                  />
                </FormControl>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}

/** Extra tabs on the product page, such as size guide or care. */
export function AdditionalSectionsCard({ form, readOnly }: SectionProps) {
  const t = useMessages(productMessages);
  const sections = useWatch({ control: form.control, name: "additionalInfo" }) ?? [];
  if (readOnly && sections.length === 0) return null;

  return (
    <CollapsibleCard title={t("additionalSections")} defaultOpen={readOnly || sections.length > 0}>
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
            render={({ field }) => (
              <FormItem>
                <AdditionalInfoManager initialContent={field.value ?? []} onContentChange={field.onChange} />
                <FormMessage />
              </FormItem>
            )}
          />
        </Suspense>
      )}
    </CollapsibleCard>
  );
}
