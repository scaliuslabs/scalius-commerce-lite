import { memo } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CollapsibleCard } from "./CollapsibleCard";
import {
  PRODUCT_OPTION_SCHEMA_VALUES,
  type ProductFormValues,
  type ProductOptionSchema,
} from "./types";

const OPTION_SCHEMA_LABELS: Record<ProductOptionSchema, string> = {
  size: "Size",
  color: "Color",
  material: "Material",
  pattern: "Pattern",
  none: "No standard mapping",
};

interface OptionDiscoverySectionProps {
  form: UseFormReturn<ProductFormValues>;
  embedded?: boolean;
}

export const OptionDiscoverySection = memo(function OptionDiscoverySection({
  form,
  embedded = false,
}: OptionDiscoverySectionProps) {
  const optionOneLabel = form.watch("variantOption1Label")?.trim() || "Option 1";
  const optionTwoLabel = form.watch("variantOption2Label")?.trim() || "Option 2";

  const content = (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs font-semibold">Choice axes</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Name the choices customers make, such as Size, Color, Shape, Pack,
          Format, or 2-in-1. Values and sellable combinations are managed in
          the variant table directly below.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
          <OptionMappingFields
            form={form}
            labelName="variantOption1Label"
            schemaName="variantOption1Schema"
            title="Option 1"
            description="Maps existing SKU option 1 values."
          />
          <OptionMappingFields
            form={form}
            labelName="variantOption2Label"
            schemaName="variantOption2Schema"
            title="Option 2"
            description="Maps existing SKU option 2 values."
          />
      </div>
    </div>
  );

  if (embedded) return content;

  return (
    <CollapsibleCard
      title="Product options"
      description={`${optionOneLabel} · ${optionTwoLabel}`}
      defaultOpen={false}
    >
      {content}
    </CollapsibleCard>
  );
});

function OptionMappingFields({
  form,
  labelName,
  schemaName,
  title,
  description,
}: {
  form: UseFormReturn<ProductFormValues>;
  labelName: "variantOption1Label" | "variantOption2Label";
  schemaName: "variantOption1Schema" | "variantOption2Schema";
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="grid gap-2">
        <FormField
          control={form.control}
          name={labelName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Option name</FormLabel>
              <FormControl>
                <Input
                  className="h-9"
                  maxLength={40}
                  placeholder={title}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name={schemaName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Standard mapping</FormLabel>
              <Select
                value={field.value}
                onValueChange={(value) =>
                  field.onChange(value as ProductOptionSchema)
                }
              >
                <FormControl>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent side="bottom" align="start">
                  {PRODUCT_OPTION_SCHEMA_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {OPTION_SCHEMA_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription className="text-[10px] leading-4">
                Optional feed/search meaning; it never limits the option name or values.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}
