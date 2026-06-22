// src/components/admin/ProductForm/variants/VariantFormRow.tsx

import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  defaultValues?: Partial<VariantFormValues>;
  onSave: (values: VariantFormValues) => Promise<boolean>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function VariantFormRow({
  initialData,
  defaultValues,
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
      trackInventory: true,
      discountType: "percentage",
      discountPercentage: null,
      discountAmount: null,
      ...defaultValues,
    },
  });

  const handleSubmit: SubmitHandler<VariantFormValues> = async (values) => {
    const hasCustomerOption = Boolean(values.size?.trim() || values.color?.trim());
    if (!hasCustomerOption) {
      const message = "Add at least one option value.";
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
  const trackInventory = form.watch("trackInventory") !== false;

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
                <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Option 1 (size/weight)
                </div>
                <FormControl>
                  <Input
                    placeholder="2KG, XL, 100ml"
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
                <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Option 2 (color/style)
                </div>
                <FormControl>
                  <Input
                    placeholder="Red, Blue, Pack A"
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
            name="trackInventory"
            render={({ field }) => (
              <FormItem className="mb-2 space-y-0">
                <div className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">Track stock</span>
                  <FormControl>
                    <Switch
                      checked={field.value !== false}
                      onCheckedChange={(checked) => field.onChange(checked)}
                      aria-label="Track stock for this option"
                    />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="stock"
            render={({ field }) => (
              <FormItem>
                {trackInventory ? (
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
                ) : (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                    No stock limit
                  </div>
                )}
                {trackInventory && isEditMode && initialData && (
                  <p className="text-[10px] text-muted-foreground px-1 mt-0.5">
                    Available: {Math.max(0, (field.value ?? 0) - (initialData.reservedStock ?? 0))}
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
