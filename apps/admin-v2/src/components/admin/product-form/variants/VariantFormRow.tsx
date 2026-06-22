// src/components/admin/ProductForm/variants/VariantFormRow.tsx

import type { ReactNode } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { TableCell, TableRow } from "@/components/ui/table";
import { generateEAN13 } from "@scalius/shared/barcode-utils";
import { cn } from "@scalius/shared/utils";
import { Barcode, Loader2, Save, Sparkles, X } from "lucide-react";
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
  const compactInputClass = layout === "row"
    ? "h-8 rounded-none border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-0"
    : "h-8 rounded-md bg-background px-2 text-xs shadow-none";
  const messageClass = layout === "row"
    ? "absolute left-1 top-full z-20 mt-0.5 rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground shadow"
    : "px-1 pt-0.5 text-[10px]";
  const cellClass = "border-r p-0 align-middle last:border-r-0";
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
    messageClass,
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
                <StockLimitField {...controlProps} />
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
        <TableCell className={cn(cellClass, "w-10")}>
          <span
            className="mx-auto block h-2 w-2 rounded-full bg-primary"
            title={isEditMode ? "Editing option" : "Adding option"}
          />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[150px]")}>
          <SkuField {...controlProps} autoFocus={isEditMode} />
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
        <TableCell className={cn(cellClass, "min-w-[112px]")}>
          <StockLimitField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[80px]")}>
          <StockField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[80px]")}>
          {trackInventory ? (
            <span className="block px-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              {availableStock ?? "New"}
            </span>
          ) : (
            <span className="block px-2 text-xs text-muted-foreground">-</span>
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
        <TableCell className={cn(cellClass, "w-[116px] min-w-[116px]")}>
          <div className="flex items-center justify-end gap-1 px-1">
            <BarcodePopover
              barcodeValue={barcodeValue}
              barcodeType={barcodeType}
              controlProps={controlProps}
            />
            <ActionButtons {...controlProps} />
          </div>
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
  messageClass: string;
  onCancel: () => void;
  onSubmit: () => void;
};

function SkuField({
  form,
  compactInputClass,
  messageClass,
  autoFocus,
}: ControlProps & { autoFocus?: boolean }) {
  return (
    <FormField
      control={form.control}
      name="sku"
      render={({ field }) => (
        <FormItem className="relative min-w-0 flex-1 space-y-0">
          <FormControl>
            <Input
              placeholder="SKU-123"
              {...field}
              className={cn(compactInputClass, "font-mono")}
              autoFocus={autoFocus}
            />
          </FormControl>
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

function OptionOneField({
  form,
  compactInputClass,
  messageClass,
  autoFocus,
}: ControlProps & { autoFocus?: boolean }) {
  return (
    <FormField
      control={form.control}
      name="size"
      render={({ field }) => (
        <FormItem className="relative min-w-0 space-y-0">
          <FormControl>
            <Input
              placeholder="2KG, XL"
              {...field}
              value={field.value ?? ""}
              className={compactInputClass}
              autoFocus={autoFocus}
            />
          </FormControl>
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

function OptionTwoField({ form, compactInputClass, messageClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="color"
      render={({ field }) => (
        <FormItem className="relative min-w-0 space-y-0">
          <FormControl>
            <Input
              placeholder="Red, Pack A"
              {...field}
              value={field.value ?? ""}
              className={compactInputClass}
            />
          </FormControl>
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

function WeightField({ form, compactInputClass, messageClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="weight"
      render={({ field }) => (
        <FormItem className="relative min-w-0 space-y-0">
          <FormControl>
            <Input
              type="number"
              placeholder="0"
              {...field}
              value={field.value ?? ""}
              className={compactInputClass}
            />
          </FormControl>
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

function PriceField({ form, compactInputClass, messageClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="price"
      render={({ field }) => (
        <FormItem className="relative min-w-0 space-y-0">
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
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

function StockField({ form, compactInputClass, messageClass, trackInventory }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="stock"
      render={({ field }) => (
        <FormItem className="relative min-w-0 flex-1 space-y-0">
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
            <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
              -
            </div>
          )}
          <FormMessage className={messageClass} />
        </FormItem>
      )}
    />
  );
}

function StockLimitField({ form, compactInputClass }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="trackInventory"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <Select
              value={field.value === false ? "unlimited" : "tracked"}
              onValueChange={(value) => field.onChange(value === "tracked")}
            >
              <SelectTrigger
                aria-label="Stock limit for this option"
                className={cn(compactInputClass, "justify-between")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tracked">Track stock</SelectItem>
                <SelectItem value="unlimited">No stock limit</SelectItem>
              </SelectContent>
            </Select>
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function DiscountField({ form, symbol, discountType, compactInputClass, messageClass }: ControlProps) {
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
                <SelectTrigger className={cn(compactInputClass, "justify-between")}>
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
            <FormItem className="relative min-w-0 flex-1 space-y-0">
              <FormControl>
                <Input
                  type="number"
                  placeholder="0"
                  {...field}
                  value={field.value ?? ""}
                  className={compactInputClass}
                />
              </FormControl>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />
      ) : (
        <FormField
          control={form.control}
          name="discountAmount"
          render={({ field }) => (
            <FormItem className="relative min-w-0 flex-1 space-y-0">
              <FormControl>
                <Input
                  type="number"
                  placeholder="0"
                  {...field}
                  value={field.value ?? ""}
                  className={compactInputClass}
                />
              </FormControl>
              <FormMessage className={messageClass} />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}

function BarcodeFields({ form, compactInputClass, messageClass }: ControlProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_104px_32px]">
      <FormField
        control={form.control}
        name="barcode"
        render={({ field }) => (
          <FormItem className="relative min-w-0 space-y-0">
            <FormControl>
              <Input
                placeholder="Optional"
                {...field}
                value={field.value ?? ""}
                className={cn(compactInputClass, "font-mono")}
              />
            </FormControl>
            <FormMessage className={messageClass} />
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
                <SelectTrigger className={cn(compactInputClass, "justify-between")}>
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
          aria-label={hasBarcode ? "Edit barcode details" : "Add barcode details"}
          title={hasBarcode ? `${barcodeValue}${barcodeType ? ` (${barcodeType})` : ""}` : "Barcode details"}
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
