// src/components/admin/ProductForm/variants/VariantFormRow.tsx

import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { TableCell, TableRow } from "@/components/ui/table";
import { Loader2, X, Save } from "lucide-react";
import { variantFormSchema, type VariantFormValues, type ProductVariant } from "./types";

interface VariantFormRowProps {
  initialData?: ProductVariant;
  onSave: (values: VariantFormValues) => Promise<boolean>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function VariantFormRow({
  initialData,
  onSave,
  onCancel,
  isSubmitting,
}: VariantFormRowProps) {
  const isEditMode = !!initialData?.id;

  const form = useForm<VariantFormValues>({
    resolver: zodResolver(variantFormSchema),
    defaultValues: initialData || {
      size: "",
      color: "",
      weight: null,
      sku: "",
      price: 0,
      stock: 0,
      discountType: "percentage",
      discountPercentage: null,
      discountAmount: null,
    },
  });

  const handleSubmit: SubmitHandler<VariantFormValues> = async (values) => {
    const success = await onSave(values);
    if (success) {
      form.reset();
    }
  };

  const discountType = form.watch("discountType");

  return (
    <TableRow className="bg-primary/5 border-l-4 border-l-primary hover:bg-primary/5 shadow-sm">
      <Form {...form}>
        <TableCell className="p-2"></TableCell>

        <TableCell className="p-2 align-top">
          <FormField
            control={form.control}
            name="sku"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="SKU-123"
                    {...field}
                    className="h-9 font-mono"
                    autoFocus={!isEditMode}
                  />
                </FormControl>
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        <TableCell className="p-2 align-top">
          <FormField
            control={form.control}
            name="size"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="XL"
                    {...field}
                    value={field.value ?? ""}
                    className="h-9"
                  />
                </FormControl>
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        <TableCell className="p-2 align-top">
          <FormField
            control={form.control}
            name="color"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="Red"
                    {...field}
                    value={field.value ?? ""}
                    className="h-9"
                  />
                </FormControl>
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        <TableCell className="p-2 align-top">
          <FormField
            control={form.control}
            name="weight"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="0"
                    {...field}
                    value={field.value ?? ""}
                    className="h-9"
                  />
                </FormControl>
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        <TableCell className="p-2 align-top">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="0.00"
                    step="0.01"
                    {...field}
                    value={field.value === 0 ? "" : field.value ?? ""}
                    onChange={(e) => {
                      const value = e.target.value ? parseFloat(e.target.value) : 0;
                      field.onChange(value);
                    }}
                    className="h-9"
                  />
                </FormControl>
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        <TableCell className="p-2 align-top">
          <FormField
            control={form.control}
            name="stock"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="number"
                    placeholder="0"
                    {...field}
                    value={field.value === 0 ? "" : field.value ?? ""}
                    onChange={(e) => {
                      const value = e.target.value ? parseInt(e.target.value, 10) : 0;
                      field.onChange(value);
                    }}
                    className="h-9"
                  />
                </FormControl>
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        <TableCell className="p-2 align-top">
          <div className="flex gap-1">
            <FormField
              control={form.control}
              name="discountType"
              render={({ field }) => (
                <FormItem className="w-20">
                  <FormControl>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">%</SelectItem>
                        <SelectItem value="flat">৳</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage className="text-xs px-1" />
                </FormItem>
              )}
            />
            {discountType === "percentage" ? (
              <FormField
                control={form.control}
                name="discountPercentage"
                render={({ field }) => (
                  <FormItem className="w-20">
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="0"
                        {...field}
                        value={field.value ?? ""}
                        className="h-9"
                      />
                    </FormControl>
                    <FormMessage className="text-xs px-1" />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="discountAmount"
                render={({ field }) => (
                  <FormItem className="w-20">
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="0"
                        {...field}
                        value={field.value ?? ""}
                        className="h-9"
                      />
                    </FormControl>
                    <FormMessage className="text-xs px-1" />
                  </FormItem>
                )}
              />
            )}
          </div>
        </TableCell>

        <TableCell className="p-2 align-top"></TableCell>

        <TableCell className="p-2 align-top text-right">
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onCancel}
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
              disabled={isSubmitting}
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              onClick={form.handleSubmit(handleSubmit)}
              disabled={isSubmitting}
              className="h-9 w-9"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
            </Button>
          </div>
        </TableCell>
      </Form>
    </TableRow>
  );
}
