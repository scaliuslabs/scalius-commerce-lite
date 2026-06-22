// src/components/admin/ProductForm/variants/VariantFormRow.tsx

import type { ReactNode } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { Check, Loader2, Sparkles, X } from "lucide-react";
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
  const compactInputClass = layout === "row"
    ? "h-8 rounded-[4px] border border-transparent bg-transparent px-2 text-xs shadow-none transition-colors hover:border-border hover:bg-background focus-visible:border-primary focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary/15 focus-visible:ring-offset-0"
    : "h-8 rounded-[4px] bg-background px-2 text-xs shadow-none focus-visible:ring-2 focus-visible:ring-primary/15 focus-visible:ring-offset-0";
  const messageClass = layout === "row"
    ? "absolute left-1 top-full z-20 mt-0.5 rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground shadow"
    : "px-1 pt-0.5 text-[10px]";
  const cellClass = "h-10 border-r p-0 align-middle last:border-r-0";
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
      <TableRow className="border-y border-primary/25 bg-primary/[0.025] hover:bg-primary/[0.035]">
        <TableCell className={cn(cellClass, "w-10")}>
          <span
            className="mx-auto block h-3.5 w-3.5 rounded-[4px] border border-primary/45 bg-primary/10"
            title={isEditMode ? "Editing option" : "Adding option"}
          />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[140px] px-1")}>
          <SkuField {...controlProps} autoFocus={isEditMode} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[105px] px-1")}>
          <OptionOneField {...controlProps} autoFocus={!isEditMode} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[105px] px-1")}>
          <OptionTwoField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[56px] px-1")}>
          <WeightField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[80px] px-1")}>
          <PriceField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[116px] px-1")}>
          <StockLimitField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[68px] px-1")}>
          <StockField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[68px]")}>
          {trackInventory ? (
            <span className="block px-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              {availableStock ?? "New"}
            </span>
          ) : (
            <span className="block px-2 text-xs text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[82px] px-1")}>
          <DiscountField {...controlProps} />
        </TableCell>
        <TableCell className={cn(cellClass, "min-w-[86px]")}>
          <span className="text-[11px] text-muted-foreground">
            {isEditMode ? "Editing" : "New"}
          </span>
        </TableCell>
        <TableCell
          className={cn(
            cellClass,
            "sticky right-0 z-20 w-[72px] min-w-[72px] bg-primary/[0.025] shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.35)]",
          )}
        >
          <div className="flex items-center justify-end gap-1 px-1">
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

function StockLimitField({ form }: ControlProps) {
  return (
    <FormField
      control={form.control}
      name="trackInventory"
      render={({ field }) => (
        <FormItem className="space-y-0">
          <FormControl>
            <div
              className="grid h-8 grid-cols-2 overflow-hidden rounded-[4px] border border-border bg-background p-0.5 text-[11px] shadow-none"
              role="group"
              aria-label="Stock limit for this option"
            >
              <button
                type="button"
                aria-label="Track stock"
                aria-pressed={field.value !== false}
                title="Track stock"
                className={cn(
                  "whitespace-nowrap rounded-[3px] px-1.5 font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
                  field.value !== false && "bg-emerald-50 text-emerald-700 shadow-sm dark:bg-emerald-950/30 dark:text-emerald-300",
                )}
                onClick={() => field.onChange(true)}
              >
                Track
              </button>
              <button
                type="button"
                aria-label="No stock limit"
                aria-pressed={field.value === false}
                title="No stock limit"
                className={cn(
                  "whitespace-nowrap rounded-[3px] px-1.5 font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
                  field.value === false && "bg-slate-100 text-slate-700 shadow-sm dark:bg-slate-800 dark:text-slate-200",
                )}
                onClick={() => field.onChange(false)}
              >
                No limit
              </button>
            </div>
          </FormControl>
        </FormItem>
      )}
    />
  );
}

function DiscountField({ form, symbol, discountType, compactInputClass, messageClass }: ControlProps) {
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-1">
      <FormField
        control={form.control}
        name="discountType"
        render={({ field }) => (
          <FormItem className="space-y-0">
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
                <SelectTrigger className={cn(compactInputClass, "justify-between px-1.5")}>
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
        className="h-8 w-8 shadow-none after:shadow-none"
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
          className="h-8 w-8 shadow-none after:shadow-none"
          disabled={isSubmitting}
          aria-label={isEditMode ? "Cancel option edit" : "Cancel option creation"}
          title={isEditMode ? "Cancel option edit" : "Cancel option creation"}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onSubmit}
          className="h-8 w-8 border-emerald-200 bg-emerald-50 text-emerald-700 shadow-none hover:bg-emerald-100 hover:text-emerald-800 after:shadow-none dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          disabled={isSubmitting}
          aria-label={saveLabel}
          title={saveLabel}
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
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
        className="h-7 w-7 shadow-none after:shadow-none"
        disabled={isSubmitting}
        aria-label={isEditMode ? "Cancel option edit" : "Cancel option creation"}
        title={isEditMode ? "Cancel option edit" : "Cancel option creation"}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={onSubmit}
        className="h-7 w-7 border-emerald-200 bg-emerald-50 text-emerald-700 shadow-none hover:bg-emerald-100 hover:text-emerald-800 after:shadow-none dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
        disabled={isSubmitting}
        aria-label={saveLabel}
        title={saveLabel}
      >
        {isSubmitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
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
