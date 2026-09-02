import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "../../ui/form";
import { Card } from "../../ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { DeferredTiptapEditor } from "../../ui/tiptap/DeferredTiptapEditor";
import type { CollectionFormInput, CollectionFormValues } from "./types";

interface CollectionContentSectionProps {
  form: UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;
}

export function CollectionContentSection({ form }: CollectionContentSectionProps) {
  return (
    <Card className="overflow-hidden">
      <Tabs defaultValue="introduction" className="w-full">
        <TabsList className="h-11 w-full justify-start rounded-none border-b bg-transparent p-0 md:h-9">
          <TabsTrigger
            value="introduction"
            className="h-11 rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent md:h-9"
          >
            Introduction
          </TabsTrigger>
          <TabsTrigger
            value="below-products"
            className="h-11 rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent md:h-9"
          >
            Below products
          </TabsTrigger>
        </TabsList>

        <TabsContent value="introduction" className="m-0 p-3">
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
                    ariaLabel="Collection introduction"
                    compact
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </TabsContent>

        <TabsContent value="below-products" className="m-0 p-3">
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
                    ariaLabel="Collection content below products"
                    compact
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
