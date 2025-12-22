// src/components/admin/product-form/TitleDescriptionSection.tsx
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

import { TiptapEditor } from "@/components/ui/tiptap-editor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import {
  AdditionalInfoManager,
  type RichContentItem,
} from "./AdditionalInfoManager";
import type { ProductFormValues } from "./types";

interface TitleDescriptionSectionProps {
  form: UseFormReturn<ProductFormValues>;
  isClient: boolean;
}

export function TitleDescriptionSection({
  form,
  isClient,
}: TitleDescriptionSectionProps) {
  return (
    <div className="space-y-4">
      {/* Product Title */}
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="text-sm font-medium">
              Title <span className="text-destructive">*</span>
            </FormLabel>
            <FormControl>
              <Input
                placeholder="Product title"
                {...field}
                className="text-base"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Product Description with Additional Info Tabs */}
      <Card className="overflow-hidden">
        <Tabs defaultValue="description" className="w-full">
          <TabsList className="w-full justify-start rounded-none border-b h-9 p-0 bg-transparent">
            <TabsTrigger
              value="description"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs px-3 h-9"
            >
              Description
            </TabsTrigger>
            <TabsTrigger
              value="additional"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs px-3 h-9"
            >
              Additional Sections
            </TabsTrigger>
          </TabsList>

          <TabsContent value="description" className="p-3 m-0">
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    {isClient ? (
                      <TiptapEditor
                        content={field.value || ""}
                        onChange={field.onChange}
                        placeholder="Describe your product..."
                        compact={true}
                      />
                    ) : (
                      <div
                        className="border rounded-md p-4"
                        style={{ minHeight: "200px" }}
                      >
                        <div className="text-muted-foreground text-sm">
                          Loading editor...
                        </div>
                      </div>
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </TabsContent>

          <TabsContent value="additional" className="p-3 m-0">
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
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
