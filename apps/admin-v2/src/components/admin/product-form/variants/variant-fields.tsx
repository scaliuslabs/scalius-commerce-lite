// The fields of one variant, shared by the simple-product inventory card and the variant table.
import React from "react";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { detectBarcodeType } from "@scalius/shared/barcode-identity";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductSkuImageChoice } from "~/lib/api-query-options/products";
import type { DraftIssueField, DraftVariant } from "./option-matrix-editor-model";

/** The message a field shows, if the current (or server's) problem is about it. */
export type IssueFor = (variantId: string | undefined, field: DraftIssueField) => string | undefined;

/** Typing or scanning a barcode picks its type (EAN-13, UPC, …); clearing it removes both. */
export function barcodePatch(value: string): Pick<DraftVariant, "barcode" | "barcodeType"> {
  const barcode = value.trim() ? value : null;
  return { barcode, barcodeType: barcode ? detectBarcodeType(barcode) : null };
}

/** A labelled field with its help and its problem underneath (one error indicator: text + border). */
export function Field({ label, help, error, children }: {
  label: string;
  help?: string;
  error?: string;
  children: (invalid: boolean) => React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-body text-muted-foreground">
      {label}
      {children(Boolean(error))}
      {error ? <span className="block text-destructive">{error}</span> : help ? <span className="block">{help}</span> : null}
    </label>
  );
}

export function InventoryQuantityInput({ value, committed, onChange, ariaLabel, invalid = false, cell }: {
  /** Marks the field for the table's arrow-key navigation (see VariantTable). */
  cell?: string;
  value: number;
  committed: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const t = useMessages(productMessages);
  const available = Math.max(0, value - committed);
  return (
    <div className="space-y-1">
      <NumberInput
        value={value}
        integer
        aria-invalid={invalid}
        aria-label={ariaLabel ?? t("quantity")}
        data-cell={cell}
        // Empty or not a number stays visible as a problem instead of turning into 0.
        onValueChange={(next) => onChange(next ?? Number.NaN)}
      />
      {committed > 0 && Number.isFinite(value) ? (
        <p className="text-right text-body text-muted-foreground tabular-nums" title={t("inOpenOrders", { onHand: value, committed })}>
          {t("availableToSell", { count: available })}
        </p>
      ) : null}
    </div>
  );
}

// Variant photo = an exact product image, or null to use the product's main photo.
export function VariantImagePicker({ value, images, onChange, label, allowNoChange = false, invalid = false }: {
  value: string | null | undefined;
  images: ProductSkuImageChoice[];
  onChange: (value: string | null | undefined) => void;
  label?: string;
  allowNoChange?: boolean;
  invalid?: boolean;
}) {
  const t = useMessages(productMessages);
  const selectedIndex = images.findIndex((image) => image.id === value);
  const selected = images[selectedIndex];
  // Every photo is named by its position and description, so similar photos can be told apart.
  const photoName = (index: number) => {
    const image = images[index]!;
    return [
      t("photoNumberOf", { number: index + 1, total: images.length }),
      image.altText || null,
      image.status === "trashed" ? t("mediaInTrash") : null,
    ].filter(Boolean).join(", ");
  };
  const state = value === undefined
    ? t("photoNoChange")
    : value === null || !selected
      ? t("mainPhoto")
      : photoName(selectedIndex);
  const triggerLabel = `${label ?? t("variantPhoto")}: ${state}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="overflow-hidden" aria-label={triggerLabel} aria-invalid={invalid || undefined}>
          {selected
            ? <img
                src={mediaImageUrl(selected.url, 80)}
                alt=""
                className="h-full w-full object-contain object-center"
              />
            : <ImageIcon className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        {allowNoChange ? (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className={cn("mb-1 flex min-h-11 w-full items-center gap-2 rounded p-1.5 text-left text-body hover:bg-muted", value === undefined && "bg-muted")}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded border"><ImageIcon className="h-4 w-4" /></span>
            {t("photoNoChange")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn("mb-1 flex min-h-11 w-full items-center gap-2 rounded p-1.5 text-left text-body hover:bg-muted", value === null && "bg-muted")}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded border">
            <ImageIcon className="h-4 w-4" />
          </span>
          {t("mainPhoto")}
        </button>
        <div className="grid max-h-56 grid-cols-4 gap-1 overflow-y-auto">
          {images.map((image, index) => {
            const unavailable = image.status === "trashed" && value !== image.id;
            return (
              <button
                key={image.id}
                type="button"
                disabled={unavailable}
                onClick={() => onChange(image.id)}
                aria-label={photoName(index)}
                aria-pressed={value === image.id}
                className={cn(
                  "relative aspect-square overflow-hidden rounded border-2",
                  value === image.id ? "border-primary" : "border-transparent",
                  unavailable && "cursor-not-allowed opacity-45",
                )}
                title={photoName(index)}
              >
                <img
                  src={mediaImageUrl(image.url, 96)}
                  alt=""
                  className="h-full w-full object-contain object-center"
                />
                {image.status === "trashed" ? <span className="absolute inset-x-0 bottom-0 truncate bg-foreground py-0.5 text-body text-background">{t("mediaInTrash")}</span> : null}
              </button>
            );
          })}
        </div>
        {images.length === 0 ? (
          <p className="px-1 py-2 text-body text-muted-foreground">{t("addPhotosFirst")}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function DiscountInput({ variant, name, invalid, onChange }: {
  variant: DraftVariant;
  name: string;
  invalid: boolean;
  onChange: (patch: Partial<DraftVariant>) => void;
}) {
  const t = useMessages(productMessages);
  const { code: currencyCode } = useCurrency();
  const amount = variant.discountType === "flat" ? variant.discountAmount ?? 0 : variant.discountPercentage ?? 0;
  const [mode, setMode] = React.useState<"none" | "percentage" | "flat">(
    amount > 0 ? variant.discountType : "none",
  );
  return (
    <div className="flex min-w-0 gap-1">
      <NativeSelect
        value={mode}
        onValueChange={(next) => {
          setMode(next as "none" | "percentage" | "flat");
          if (next === "none") {
            onChange({ discountType: "percentage", discountPercentage: null, discountAmount: null });
          } else if (next === "percentage") {
            onChange({ discountType: "percentage", discountPercentage: 0, discountAmount: null });
          } else {
            onChange({ discountType: "flat", discountAmount: 0, discountPercentage: null });
          }
        }}
        aria-label={t("discountTypeFor", { name })}
        className="min-w-24 flex-1"
      >
        <option value="none">{t("noDiscount")}</option>
        <option value="percentage">{t("discountPercentage")}</option>
        <option value="flat">{t("discountFixed")}</option>
      </NativeSelect>
      {mode === "flat" ? (
        <MoneyInput
          currencyCode={currencyCode}
          value={amount}
          aria-invalid={invalid}
          aria-label={t("discountValueFor", { name })}
          onValueChange={(next) => onChange({ discountAmount: next ?? 0 })}
          className="w-20"
        />
      ) : mode === "percentage" ? (
        <NumberInput
          value={amount}
          aria-invalid={invalid}
          aria-label={t("discountValueFor", { name })}
          onValueChange={(next) => onChange({ discountPercentage: next ?? 0 })}
          className="w-20"
        />
      ) : null}
    </div>
  );
}

export function AdvancedSkuFields({ variant, name, issueFor, onChange }: {
  variant: DraftVariant;
  name: string;
  issueFor: IssueFor;
  onChange: (patch: Partial<DraftVariant>) => void;
}) {
  const t = useMessages(productMessages);
  const isUnsavedSku = variant.id.startsWith("draft_");
  const errorOf = (field: DraftIssueField) => issueFor(variant.id, field);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t("sku")} error={errorOf("sku")}>
        {(invalid) => (
          <Input value={variant.sku} aria-invalid={invalid} onChange={(event) => onChange({ sku: event.target.value })} aria-label={t("skuFor", { name })} />
        )}
      </Field>
      <Field label={t("discount")} error={errorOf("discount")}>
        {(invalid) => <DiscountInput variant={variant} name={name} invalid={invalid} onChange={onChange} />}
      </Field>
      {/* Scan or type: the type is picked from the code, and can still be changed. */}
      <Field label={t("barcode")} help={isUnsavedSku && !variant.barcode ? t("barcodeHint") : undefined} error={errorOf("barcode")}>
        {(invalid) => (
          <Input
            value={variant.barcode ?? ""}
            aria-invalid={invalid}
            aria-label={t("barcodeFor", { name })}
            autoComplete="off"
            onChange={(event) => onChange(barcodePatch(event.target.value))}
          />
        )}
      </Field>
      <Field label={t("barcodeType")}>
        {() => (
          <NativeSelect
            value={variant.barcodeType ?? "none"}
            onValueChange={(value) => onChange(value === "none"
              ? { barcodeType: null, barcode: null }
              : { barcodeType: value as DraftVariant["barcodeType"] })}
          >
            <option value="none">{t(isUnsavedSku ? "barcodeAuto" : "noBarcode")}</option>
            <option value="ean13">EAN-13</option>
            <option value="upc">UPC</option>
            <option value="isbn">ISBN</option>
            <option value="gtin">GTIN</option>
            <option value="code128">Code 128</option>
            <option value="custom">{t("barcodeCustom")}</option>
          </NativeSelect>
        )}
      </Field>
      <Field label={t("weightGrams")} error={errorOf("weight")}>
        {(invalid) => (
          <NumberInput
            value={variant.weight}
            aria-invalid={invalid}
            aria-label={t("weightFor", { name })}
            onValueChange={(weight) => onChange({ weight })}
          />
        )}
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-body md:min-h-8">
        <Switch checked={variant.trackInventory} onCheckedChange={(trackInventory) => onChange({ trackInventory })} />
        {t("trackQuantity")}
      </label>
    </div>
  );
}
