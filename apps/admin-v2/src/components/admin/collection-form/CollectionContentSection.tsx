import type { UseFormReturn } from "react-hook-form";
import { Card, CardContent } from "~/components/ui/card";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { RichContent } from "~/components/ui/rich-content";
import { DeferredTiptapEditor } from "~/components/ui/tiptap/DeferredTiptapEditor";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import type { CollectionFormInput, CollectionFormValues } from "./types";

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
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("title")}</FormLabel>
              <FormControl>
                <Input placeholder={t("titlePlaceholder")} maxLength={100} required {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
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
                render={({ field }) => (
                  <FormItem>
                    {readOnly ? (
                      <RichContent content={field.value || ""} />
                    ) : (
                      <FormControl>
                        <DeferredTiptapEditor
                          content={field.value || ""}
                          onChange={field.onChange}
                          placeholder={editor.placeholder}
                          ariaLabel={`${t("description")}: ${editor.tab}`}
                          compact
                        />
                      </FormControl>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
