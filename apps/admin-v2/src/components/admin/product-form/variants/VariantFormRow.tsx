// src/components/admin/ProductForm/variants/VariantFormRow.tsx

import type { ReactNode } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import { generateEAN13 } from "@scalius/shared/barcode-utils";
import { cn } from "@scalius/shared/utils";
import { Barcode, Check, Loader2, Save, Sparkles, X } from "lucide-react";
import { useCurrency } from "@/hooks/use-currency";
import { variantOptionFormSchema, type ProductVariant, type VariantFormValues } from "./types";

interface VariantFormRowProps {
  initialData?: ProductVariant;
  defaultValues?: Partial<VariantFormValues>;
  onSave: (values: VariantFormValues) => Promise<boolean>;
  onCancel: () => void;
  isSubmitting: boolean;
}

type VariantEditorLayout = "row" | "card";

export function VariantFormEditor(props: VariantFormRowProps) {
  return <VariantOptionForm {...props} layout="card" />;
}

export function VariantFormRow(props: VariantFormRowProps) {
  return <VariantOptionForm {...props} layout="row" />;
}

function VariantOptionForm({
  initialData,
  defaultValues,
  onSave,
  onCancel,
  isSubmitting,
  layout,
}: VariantFormRowProps & { layout: VariantEditorLayout }) {
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
  const stockValue = form.watch("stock");
  const availableStock = trackInventory && isEditMode
    ? Math.max(0, Number(stockValue ?? 0) - (initialData?.reservedStock ?? 0))
    : null;
  const saveLabel = isEditMode ? "Save option" : "Create option";
  const barcodeValue = form.watch("barcode");
  const barcodeType = form.watch("barcodeType");
  const compactInputClass = "h-8 rounded-md bg-background px-2 text-xs shadow-none";
  const cellClass = "p-1.5 align-middle";
  const controlProps = {
    form,
    symbol,
    discountType,
    trackInventory,
    availableStock,
    isEditMode,
    isSubmitting,
    saveLabel,
    compactInputClass,
    onCancel,
    onSubmit: form.handleSubmit(handleSubmit),
  };

  if (layout === "card") {
    return (
      <Form {...form}>
        <div className="rounded-lg border bg-background p-2 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2 border-b pb-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {isEditMode ? "Edit option" : "Add option"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Option 1/2 can be size, weight, color, style, or pack.
              </p>
            </div>
            <ActionButtons {...controlProps} compact />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <LabeledCell label="SKU" className="col-span-2">
              <SkuField {...controlProps} autoFocus={isEditMode} />
            </LabeledCell>
            <LabeledCell label="Option 1" hint="size, weight">
              <OptionOneField {...controlProps} autoFocus={!isEditMode} />
            </LabeledCell>
            <LabeledCell label="Option 2" hint="color, style">
              <OptionTwoField {...controlProps} />
            </LabeledCell>
            <LabeledCell label="Price">
              <PriceField {...controlProps} />
            </LabeledCell>
            <LabeledCell label="Weight">
              <WeightField {...controlProps} />
            </LabeledCell>
            <LabeledCell label="Stock" className="col-span-2">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <StockField {...controlProps} />
                <TrackInventorySwitch {...controlProps} />
              </div>
              <AvailabilityNote availableStock={availableStock} trackInventory={trackInventory} />
            </LabeledCell>
            <LabeledCell label="Discount" className="col-span-2">
              <DiscountField {...controlProps} />
            </LabeledCell>
            <LabeledCell label="Barcode" className="col-span-2">
              <BarcodeFields {...controlProps} />
            </LabeledCell>
          </div>
        </div>
      </Form>
    );
  }

  return (
    <Form {...form}>
      <TableRow className="border-y border-primary/20 bg-primary/[0.035] hover:bg-primary/[0.045]">
        <TableCell className={cn(cellClass, "w-10 pl-3")}>
          <span className="flex h-4 w-4 items-center justify-center rounded border border-primary/30 bg-background text-primary">
            <Check className="h-3 w-3" />
          </span>
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[154px]")}>
          <div className="flex items-center gap-1.5">
            <SkuField {...controlProps} autoFocus={isEditMode} />
            <BarcodePopover
              barcodeValue={barcodeValue}
              barcodeType={barcodeType}
              controlProps={controlProps}
            />
          </div>
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[120px]")}>
          <OptionOneField {...controlProps} autoFocus={!isEditMode} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[120px]")}>
          <OptionTwoField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[70px]")}>
          <WeightField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[84px]")}>
          <PriceField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[104px]")}>
          <div className="flex items-center gap-1.5">
            <StockField {...controlProps} />
            <TrackInventorySwitch {...controlProps} />
          </div>
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[80px]")}>
          {trackInventory ? (
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              {availableStock ?? "New"}
            </span>
          ) : (
            <Badge variant="outline" className="h-6 whitespace-nowrap border-emerald-200 bg-emerald-50 px-1.5 text-[10px] text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
              No limit
            </Badge>
          )}
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[118px]")}>
          <DiscountField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[76px]")}>
          <span className="text-[11px] text-muted-foreground">
            {isEditMode ? "Editing" : "New"}
          </span>
        </TableCell>
        <TableCell className={cn(cellClass, "w-[86px] min-w-[86px] pr-2")}>
          <ActionButtons {...controlProps} />
        </TableCell>
      </TableRow>
    </Form>
  );
}

type ControlProps = {
  form: ReturnType<typeof useForm<VariantFormValues>>;
  symbol: string;
  discountType: VariantFormValues["discountType"];
  trackInventory: boolean;
  availableStock: number | null;
  isEditMode: boolean;
  isSubmitting: boolean;
  saveLabel: string;
  compactInputClass: string;
  onCancel: () => void;
  onSubmit: () => void;
};

function SkuField({
  form,
  compactInputClass,
  autoFocus,
}: ControlProps & { autoFocus?: boolean }) {
  return (
    <FormField
      control={form.control}
      name="sku"
      render={({ field }) => (
        <FormItem className="min-w-0 flex-1 space-y-0">
          <FormControl>
            <Input
              placeholder="SKU-123"
              {...field}
              className={cn(compactInputClass, "font-mono")}
              autoFocus={autoFocus}
            />
          </FormControl>
          <FormMessage className="px-1 pt-0.5 text-[10px]" />
        </FormItem>
      )}
    />
  );
}

function OptionOneField({
  form,
  compactInputClass,
  autoFocus,
}: ControlProps & { autoFocus?: boolean }) {
  return (
    <FormField
      control={form.control}
      name="size"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <Input
              placeholder="2KG, XL"
              {...field}
              value={field.value ?? ""}
              className={compactInputClass}
              autoFocus={autoFocus}
            />
          </FormControl>
          <FormMessage className="px-1 pt-0.5 text-[10px]" />
        </FormItem>
      )}
    />
  );
}

function OptionTwoField({ form, compactInputClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="color"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <Input
              placeholder="Red, Pack A"
              {...field}
              value={field.value ?? ""}
              className={compactInputClass}
            />
          </FormControl>
          <FormMessage className="px-1 pt-0.5 text-[10px]" />
        </FormItem>
      )}
    />
  );
}

function WeightField({ form, compactInputClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="weight"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <Input
              type="number"
              placeholder="0"
              {...field}
              value={field.value ?? ""}
              className={compactInputClass}
            />
          </FormControl>
          <FormMessage className="px-1 pt-0.5 text-[10px]" />
        </FormItem>
      )}
    />
  );
}

function PriceField({ form, compactInputClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="price"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <Input
              type="number"
              placeholder="0.00"
              step="0.01"
              {...field}
              value={field.value === 0 ? "" : field.value ?? ""}
              onChange={(e) => field.onChange(e.target.value ? parseFloat(e.target.value) : 0)}
              className={compactInputClass}
            />
          </FormControl>
          <FormMessage className="px-1 pt-0.5 text-[10px]" />
        </FormItem>
      )}
    />
  );
}

function StockField({ form, compactInputClass, trackInventory }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="stock"
      render={({ field }) => (
        <FormItem className="min-w-0 flex-1 space-y-0">
          {trackInventory ? (
            <FormControl>
              <Input
                type="number"
                placeholder="0"
                {...field}
                value={field.value === 0 ? "" : field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value, 10) : 0)}
                className={compactInputClass}
              />
            </FormControl>
          ) : (
            <div className="flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
              No stock limit
            </div>
          )}
          <FormMessage className="px-1 pt-0.5 text-[10px]" />
        </FormItem>
      )}
    />
  );
}

function TrackInventorySwitch({ form }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="trackInventory"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <Switch
              checked={field.value !== false}
              onCheckedChange={(checked) => field.onChange(checked)}
              aria-label="Track stock for this option"
              title="Track stock for this option"
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function DiscountField({ form, symbol, discountType }: ControlProps) {
  return (
    <div className="flex gap-1.5">
      <FormField
        control={form.control}
        name="discountType"
        render={({ field }) => (
          <FormItem className="w-[58px] space-y-0">
            <FormControl>
              <Select
                onValueChange={(value) => {
                  field.onChange(value);
                  if (value === "flat") {
                    form.setValue("discountPercentage", null);
                  } else {
                    form.setValue("discountAmount", null);
                  }
                }}
                value={field.value}
              >
                <SelectTrigger className="h-8 rounded-md bg-background px-2 text-xs shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">%</SelectItem>
                  <SelectItem value="flat">{symbol}</SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
          </FormItem>
        )}
      />
      {discountType === "percentage" ? (
        <FormField
          control={form.control}
          name="discountPercentage"
          render={({ field }) => (
            <FormItem className="min-w-0 flex-1 space-y-0">
              <FormControl>
                <Input
                  type="number"
                  placeholder="0"
                  {...field}
                  value={field.value ?? ""}
                  className="h-8 rounded-md bg-background px-2 text-xs shadow-none"
                />
              </FormControl>
              <FormMessage className="px-1 pt-0.5 text-[10px]" />
            </FormItem>
          )}
        />
      ) : (
        <FormField
          control={form.control}
          name="discountAmount"
          render={({ field }) => (
            <FormItem className="min-w-0 flex-1 space-y-0">
              <FormControl>
                <Input
                  type="number"
                  placeholder="0"
                  {...field}
                  value={field.value ?? ""}
                  className="h-8 rounded-md bg-background px-2 text-xs shadow-none"
                />
              </FormControl>
              <FormMessage className="px-1 pt-0.5 text-[10px]" />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}

function BarcodeFields({ form, compactInputClass }: ControlProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_104px_32px]">
      <FormField
        control={form.control}
        name="barcode"
        render={({ field }) => (
          <FormItem className="space-y-0">
            <FormControl>
              <Input
                placeholder="Optional"
                {...field}
                value={field.value ?? ""}
                className={cn(compactInputClass, "font-mono")}
              />
            </FormControl>
            <FormMessage className="px-1 pt-0.5 text-[10px]" />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="barcodeType"
        render={({ field }) => (
          <FormItem className="space-y-0">
            <FormControl>
              <Select onValueChange={(v) => field.onChange(v || null)} value={field.value ?? ""}>
                <SelectTrigger className="h-8 rounded-md bg-background px-2 text-xs shadow-none">
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
          </FormItem>
        )}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        title="Generate EAN-13 barcode"
        onClick={() => {
          form.setValue("barcode", generateEAN13());
          form.setValue("barcodeType", "ean13");
        }}
      >
        <Sparkles className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function BarcodePopover({
  barcodeValue,
  barcodeType,
  controlProps,
}: {
  barcodeValue: string | null | undefined;
  barcodeType: string | null | undefined;
  controlProps: ControlProps;
}) {
  const hasBarcode = Boolean(barcodeValue);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={hasBarcode ? "secondary" : "ghost"}
          size="icon"
          className="h-8 w-8 shrink-0"
          title={hasBarcode ? `${barcodeValue}${barcodeType ? ` (${barcodeType})` : ""}` : "Barcode"}
        >
          <Barcode className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-3">
        <div className="mb-2">
          <p className="text-xs font-semibold text-foreground">Barcode</p>
          <p className="text-[11px] text-muted-foreground">
            Optional scan code for labels and inventory tools.
          </p>
        </div>
        <BarcodeFields {...controlProps} />
      </PopoverContent>
    </Popover>
  );
}

function ActionButtons({
  isSubmitting,
  isEditMode,
  saveLabel,
  onCancel,
  onSubmit,
  compact,
}: ControlProps & { compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onCancel}
          className="h-8 w-8"
          disabled={isSubmitting}
          aria-label={isEditMode ? "Cancel option edit" : "Cancel option creation"}
          title={isEditMode ? "Cancel option edit" : "Cancel option creation"}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          onClick={onSubmit}
          className="h-8 w-8"
          disabled={isSubmitting}
          aria-label={saveLabel}
          title={saveLabel}
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onCancel}
        className="h-8 w-8"
        disabled={isSubmitting}
        aria-label={isEditMode ? "Cancel option edit" : "Cancel option creation"}
        title={isEditMode ? "Cancel option edit" : "Cancel option creation"}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        onClick={onSubmit}
        className="h-8 w-8"
        disabled={isSubmitting}
        aria-label={saveLabel}
        title={saveLabel}
      >
        {isSubmitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

function LabeledCell({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2 px-0.5">
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function AvailabilityNote({
  availableStock,
  trackInventory,
}: {
  availableStock: number | null;
  trackInventory: boolean;
}) {
  if (!trackInventory) {
    return <p className="mt-1 px-0.5 text-[10px] text-emerald-700">No stock limit</p>;
  }

  if (availableStock === null) {
    return null;
  }

  return <p className="mt-1 px-0.5 text-[10px] text-muted-foreground">Available: {availableStock}</p>;
}
