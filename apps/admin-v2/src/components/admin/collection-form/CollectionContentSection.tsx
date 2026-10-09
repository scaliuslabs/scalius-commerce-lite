import type { UseFormReturn } from "react-hook-form";
import { Card, CardContent } from "~/components/ui/card";
import { FormField } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { RichContent } from "~/components/ui/rich-content";
import { DeferredTiptapEditor } from "~/components/ui/tiptap/DeferredTiptapEditor";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import type { CollectionFormInput, CollectionFormValues } from "./types";
import { richTextOrNull } from "~/lib/rich-text-value";
import { Field } from "~/components/ui/field";

interface CollectionContentSectionProps {
  form: UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;
  /** Without the save permission the text shows as it reads on the store. */
  readOnly?: boolean;
}

/** Title and description, the first card of the main column. */
export function CollectionContentSection({ form, readOnly = false }: CollectionContentSectionProps) {
  const t = useMessages(collectionFormMessages);
  const editors = [
    { value: "description", tab: t("aboveProducts"), placeholder: t("aboveProductsPlaceholder") },
    { value: "content", tab: t("belowProducts"), placeholder: t("belowProductsPlaceholder") },
  ] as const;

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field, fieldState }) => (
            <Field label={t("title")} error={fieldState.error?.message}>
              <Input placeholder={t("titlePlaceholder")} maxLength={100} required {...field} />
            </Field>
          )}
        />
        <Tabs defaultValue="description">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-body font-medium">{t("description")}</span>
            <TabsList>
              {editors.map((editor) => (
                <TabsTrigger key={editor.value} value={editor.value}>
                  {editor.tab}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {editors.map((editor) => (
            <TabsContent key={editor.value} value={editor.value}>
              <FormField
                control={form.control}
                name={editor.value}
                render={({ field, fieldState }) => (
                  <Field error={fieldState.error?.message}>
                    {readOnly ? (
                      <RichContent content={field.value || ""} />
                    ) : (
                      <DeferredTiptapEditor
                        content={field.value || ""}
                        onChange={(html) => field.onChange(richTextOrNull(html))}
                        placeholder={editor.placeholder}
                        ariaLabel={`${t("description")}: ${editor.tab}`}
                        compact
                      />
                    )}
                  </Field>
                )}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
