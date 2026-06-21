import { useEffect } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Barcode,
  Boxes,
  Check,
  Loader2,
  Package,
  Plus,
  Save,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import { cn, formatDate } from "@scalius/shared/utils";
import { generateEAN13 } from "@scalius/shared/barcode-utils";
import { variantFormSchema, type ProductVariant, type VariantFormValues } from "./types";

interface SimpleProductSkuPanelProps {
  variant: ProductVariant;
  onSave: (variantId: string, values: VariantFormValues) => Promise<boolean>;
  onAddOption: () => void;
  isSubmitting: boolean;
}

function formValuesFromVariant(variant: ProductVariant): VariantFormValues {
  return {
    id: variant.id,
    size: null,
    color: null,
    weight: variant.weight,
    sku: variant.sku,
    barcode: variant.barcode,
    barcodeType: variant.barcodeType,
    price: variant.price,
    stock: variant.stock,
    trackInventory: variant.trackInventory ?? true,
    discountType: variant.discountType,
    discountPercentage: variant.discountPercentage,
    discountAmount: variant.discountAmount,
  };
}

function parseOptionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

export function SimpleProductSkuPanel({
  variant,
  onSave,
  onAddOption,
  isSubmitting,
}: SimpleProductSkuPanelProps) {
  const form = useForm<VariantFormValues>({
    resolver: zodResolver(variantFormSchema),
    defaultValues: formValuesFromVariant(variant),
  });

  useEffect(() => {
    form.reset(formValuesFromVariant(variant));
  }, [form, variant]);

  const trackInventory = form.watch("trackInventory") !== false;
  const stock = Number(form.watch("stock") ?? 0);
  const available = Math.max(0, stock - (variant.reservedStock ?? 0));

  const handleSubmit: SubmitHandler<VariantFormValues> = async (values) => {
    const success = await onSave(variant.id, {
      ...values,
      size: null,
      color: null,
      trackInventory: values.trackInventory ?? false,
    });
    if (success) {
      form.reset({ ...values, size: null, color: null });
    }
  };

  return (
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <Card className="border-none shadow-none bg-transparent sm:bg-card">
      <CardHeader className="px-2 pt-2 pb-2 sm:px-3 sm:pt-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Package className="h-4 w-4 text-muted-foreground" />
              Inventory & SKU
              <Badge variant="outline" className="h-5 border-sky-200 bg-sky-50 px-1.5 text-[10px] text-sky-700">
                Simple product
              </Badge>
            </CardTitle>
            <CardDescription className="mt-1 text-xs text-muted-foreground">
              This product has one sellable SKU and no customer options.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {trackInventory ? (
              <Badge
                variant="outline"
                className={cn(
                  "h-6 px-2 text-xs",
                  available > 0
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-red-200 bg-red-50 text-red-700",
                )}
              >
                {available} available
              </Badge>
            ) : (
              <Badge variant="outline" className="h-6 border-emerald-200 bg-emerald-50 px-2 text-xs text-emerald-700">
                Always available
              </Badge>
            )}
            <Button type="button" variant="outline" size="sm" onClick={onAddOption} className="h-8 text-xs">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add size/color option
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-2 pt-0 sm:p-3 sm:pt-0">
        <Form {...form}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="sku"
                  render={({ field }) => (
                    <FormItem>
                      <Label>SKU</Label>
                      <FormControl>
                        <Input {...field} className="h-9 font-mono" />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="weight"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Weight</Label>
                      <FormControl>
                        <Input
                          type="number"
                          value={field.value ?? ""}
                          onChange={(event) => field.onChange(parseOptionalNumber(event.target.value))}
                          className="h-9"
                          placeholder="grams"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_40px]">
                <FormField
                  control={form.control}
                  name="barcode"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Barcode</Label>
                      <FormControl>
                        <div className="relative">
                          <Barcode className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            className="h-9 pl-8 font-mono"
                          />
                        </div>
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="barcodeType"
                  render={({ field }) => (
                    <FormItem>
                      <Label>Type</Label>
                      <Select onValueChange={(value) => field.onChange(value)} value={field.value ?? undefined}>
                        <FormControl>
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ean13">EAN-13</SelectItem>
                          <SelectItem value="upc">UPC</SelectItem>
                          <SelectItem value="isbn">ISBN</SelectItem>
                          <SelectItem value="gtin">GTIN</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />

                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    title="Generate EAN-13 barcode"
                    onClick={() => {
                      form.setValue("barcode", generateEAN13(), { shouldDirty: true });
                      form.setValue("barcodeType", "ean13", { shouldDirty: true });
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

            </div>

            <div className="space-y-3 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
              <FormField
                control={form.control}
                name="trackInventory"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <Label>Track stock</Label>
                        <p className="text-xs text-muted-foreground">
                          {field.value === false
                            ? "Customers can buy this SKU without a stock limit."
                            : "Customers can buy up to the available stock."}
                        </p>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value !== false}
                          onCheckedChange={(checked) => field.onChange(checked)}
                        />
                      </FormControl>
                    </div>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />

              {trackInventory ? (
                <div className="space-y-3">
                  <FormField
                    control={form.control}
                    name="stock"
                    render={({ field }) => (
                      <FormItem>
                        <Label>On hand</Label>
                        <FormControl>
                          <Input
                            type="number"
                            value={field.value ?? 0}
                            onChange={(event) => field.onChange(Number(event.target.value || 0))}
                            className="h-9"
                          />
                        </FormControl>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md bg-muted/50 p-2">
                      <div className="text-muted-foreground">Reserved</div>
                      <div className="mt-1 font-semibold text-foreground">{variant.reservedStock ?? 0}</div>
                    </div>
                    <div className="rounded-md bg-muted/50 p-2">
                      <div className="text-muted-foreground">Available</div>
                      <div className={cn("mt-1 font-semibold", available > 0 ? "text-emerald-700" : "text-red-600")}>
                        {available}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Check className="h-4 w-4" />
                    Always available
                  </div>
                  <p className="mt-1 text-xs text-emerald-800">
                    Stock numbers are ignored while tracking is off.
                  </p>
                </div>
              )}

              <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                  <Boxes className="h-3.5 w-3.5" />
                  Simple product
                </div>
                Size and color stay empty here. Price and discount stay in Pricing.
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              SKU updated <span suppressHydrationWarning>{formatDate(variant.updatedAt)}</span>
            </p>
            <Button
              type="button"
              onClick={form.handleSubmit(handleSubmit)}
              disabled={isSubmitting || !form.formState.isDirty}
              className="h-9 sm:w-auto"
            >
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save SKU
            </Button>
          </div>
        </Form>
      </CardContent>
      </Card>
    </>
  );
}
