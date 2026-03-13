// src/components/admin/product-form/BasicInfoSection.tsx
import type { UseFormReturn } from "react-hook-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { TiptapEditor } from "@/components/ui/tiptap-editor";
import type { ProductFormValues, Category } from "./types";

interface BasicInfoSectionProps {
  form: UseFormReturn<ProductFormValues>;
  categories: Category[];
  isEdit: boolean;
  isClient: boolean;
  getStorefrontPath: (path: string) => string;
}

export function BasicInfoSection({
  form,
  categories,
  isEdit,
  isClient,
  getStorefrontPath,
}: BasicInfoSectionProps) {
  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-base">Basic Information</CardTitle>
        <CardDescription className="text-xs mt-1">
          Enter the basic details of your product.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Product Name</FormLabel>
              <FormControl>
                <Input placeholder="Enter product name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Slug</FormLabel>
              <div className="flex items-center space-x-2">
                <div className="flex-grow flex items-center rounded-md border border-input bg-background px-3 text-sm ring-offset-background">
                  <span className="text-muted-foreground">/products/</span>
                  <FormControl>
                    <input
                      className="flex-grow bg-transparent py-2 outline-none placeholder:text-muted-foreground"
                      placeholder="product-url-slug"
                      {...field}
                      onChange={(e) => {
                        field.onChange(e);
                        form.setValue("slugEdited", true, {
                          shouldValidate: false,
                        });
                      }}
                    />
                  </FormControl>
                </div>
                {isEdit && field.value && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    asChild
                  >
                    <a
                      href={getStorefrontPath(`/products/${field.value}`)}
                      target="_blank"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View
                    </a>
                  </Button>
                )}
              </div>
              <FormDescription>
                The URL-friendly version of the name. Auto-generated from the
                name but can be edited.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="categoryId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Category</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="rounded-xl bg-background">
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <Card className="border-none shadow-none">
          <Accordion type="single" collapsible className="w-full" defaultValue="description">
            <AccordionItem value="description" className="border-none">
              <AccordionTrigger className="px-0 py-3 hover:no-underline">
                <div className="flex flex-col items-start text-left">
                  <h3 className="text-base font-semibold">Description</h3>
                  <p className="text-xs text-muted-foreground font-normal">
                    Add a detailed description of your product
                  </p>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-0 pb-0">
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
                            placeholder="Enter product description"
                            className="min-h-[180px]"
                          />
                        ) : (
                          <div className="border rounded-md min-h-[180px] p-4">
                            <div className="text-muted-foreground">
                              Loading editor...
                            </div>
                          </div>
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </Card>
      </CardContent>
    </Card>
  );
}
