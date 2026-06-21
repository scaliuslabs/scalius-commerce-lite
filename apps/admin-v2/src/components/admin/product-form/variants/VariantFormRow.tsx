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
import { Loader2, X, Save, Sparkles } from "lucide-react";
import { variantOptionFormSchema, type VariantFormValues, type ProductVariant } from "./types";
import { useCurrency } from "@/hooks/use-currency";
import { generateEAN13 } from "@scalius/shared/barcode-utils";

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
  const { symbol } = useCurrency();
  const isEditMode = !!initialData?.id;

  const form = useForm<VariantFormValues>({
    resolver: zodResolver(variantOptionFormSchema),
    defaultValues: initialData || {
      size: "",
      color: "",
      weight: null,
      sku: "",
      barcode: null,
      barcodeType: null,
      price: 0,
      stock: 0,
      discountType: "percentage",
      discountPercentage: null,
      discountAmount: null,
    },
  });

  const handleSubmit: SubmitHandler<VariantFormValues> = async (values) => {
    const hasCustomerOption = Boolean(values.size?.trim() || values.color?.trim());
    if (!hasCustomerOption) {
      const message = "Add a size, color, or both.";
      form.setError("size", { type: "manual", message });
      form.setError("color", { type: "manual", message });
      return;
    }

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
          <div className="space-y-1.5">
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
            <div className="flex gap-1 items-start">
              <FormField
                control={form.control}
                name="barcode"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input
                        placeholder="Barcode"
                        {...field}
                        value={field.value ?? ""}
                        className="h-7 font-mono text-xs"
                      />
                    </FormControl>
                    <FormMessage className="text-xs px-1" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="barcodeType"
                render={({ field }) => (
                  <FormItem className="w-[88px]">
                    <FormControl>
                      <Select onValueChange={(v) => field.onChange(v || null)} value={field.value ?? ""}>
                        <SelectTrigger className="h-7 text-[11px]">
                          <SelectValue placeholder="Type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ean13">EAN-13</SelectItem>
                          <SelectItem value="upc">UPC</SelectItem>
                          <SelectItem value="isbn">ISBN</SelectItem>
                          <SelectItem value="gtin">GTIN</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage className="text-xs px-1" />
                  </FormItem>
                )}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-7 w-7 shrink-0"
                title="Generate EAN-13 barcode"
                onClick={() => {
                  form.setValue("barcode", generateEAN13());
                  form.setValue("barcodeType", "ean13");
                }}
              >
                <Sparkles className="h-3 w-3" />
              </Button>
            </div>
          </div>
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
                {isEditMode && initialData && (
                  <p className="text-[10px] text-muted-foreground px-1 mt-0.5">
                    Avail: {(field.value ?? 0) - (initialData.reservedStock ?? 0)}
                  </p>
                )}
                <FormMessage className="text-xs px-1" />
              </FormItem>
            )}
          />
        </TableCell>

        {/* Empty Available column cell in edit mode */}
        <TableCell className="p-2 align-top"></TableCell>

        <TableCell className="p-2 align-top">
          <div className="flex gap-1">
            <FormField
              control={form.control}
              name="discountType"
              render={({ field }) => (
                <FormItem className="w-20">
                  <FormControl>
                    <Select onValueChange={(value) => {
                      field.onChange(value);
                      if (value === "flat") {
                        form.setValue("discountPercentage", null);
                      } else {
                        form.setValue("discountAmount", null);
                      }
                    }} value={field.value}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">%</SelectItem>
                        <SelectItem value="flat">{symbol}</SelectItem>
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
              aria-label={isEditMode ? "Cancel option edit" : "Cancel option creation"}
            >
              <X className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              onClick={form.handleSubmit(handleSubmit)}
              disabled={isSubmitting}
              className="h-9 w-9"
              aria-label={isEditMode ? "Save option" : "Create option"}
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
