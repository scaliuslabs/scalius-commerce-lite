import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "../../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { DeferredTiptapEditor } from "../../ui/tiptap/DeferredTiptapEditor";
import type { CollectionFormValues } from "./types";

interface CollectionContentSectionProps {
  form: UseFormReturn<CollectionFormValues>;
}

export function CollectionContentSection({ form }: CollectionContentSectionProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="px-4 pb-3 pt-4">
          <CardTitle className="text-base">Introduction</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <DeferredTiptapEditor
                    content={field.value || ""}
                    onChange={field.onChange}
                    placeholder="Introduce this collection above the product list"
                    compact
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 pb-3 pt-4">
          <CardTitle className="text-base">Content below products</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <FormField
            control={form.control}
            name="content"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <DeferredTiptapEditor
                    content={field.value || ""}
                    onChange={field.onChange}
                    placeholder="Add a buying guide, specifications, comparisons, or FAQs"
                    compact
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>
    </div>
  );
}
