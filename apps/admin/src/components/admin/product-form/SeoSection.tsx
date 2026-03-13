// src/components/admin/product-form/SeoSection.tsx
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CharacterCounter } from "@/components/ui/character-counter";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

interface SeoSectionProps {
  form: UseFormReturn<ProductFormValues>;
}

export function SeoSection({ form }: SeoSectionProps) {
  return (
    <CollapsibleCard
      title="Search Engine Listing"
      description="Optimize your product for search engines"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <FormField
          control={form.control}
          name="metaTitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm">Page Title</FormLabel>
              <FormControl>
                <Input
                  placeholder="Meta title for SEO"
                  className="h-9"
                  {...field}
                  value={field.value || ""}
                />
              </FormControl>
              {field.value && (
                <CharacterCounter
                  current={field.value.length}
                  recommended={60}
                  max={70}
                />
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="metaDescription"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm">Meta Description</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Meta description for SEO"
                  {...field}
                  value={field.value || ""}
                  rows={3}
                  className="resize-none"
                />
              </FormControl>
              {field.value && (
                <CharacterCounter
                  current={field.value.length}
                  recommended={160}
                  max={200}
                />
              )}
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </CollapsibleCard>
  );
}
