import { useMemo, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCurrency } from "@/hooks/use-currency";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  classifyProductVariantOptionAxes,
  MAX_PRODUCT_OPTION_COMBINATIONS,
} from "@scalius/shared/product-options";
import {
  generateVariantCombinations,
  getBulkVariantDraftKey,
  normalizeVariantDraftIdentity,
} from "../utils/variantHelpers";
import { validateSkuTemplate } from "../utils/skuGenerator";
import {
  normalizeVariantOptionLabels,
  type BulkGeneratedVariant,
  type BulkVariantOptions,
  type ProductVariant,
  type VariantOptionLabels,
} from "../types";
import { VariantAttributeInput } from "./VariantAttributeInput";
import { VariantConfigSection } from "./VariantConfigSection";
import { VariantPreviewTable } from "./VariantPreviewTable";

const OPTION_1_PRESETS = [
  { label: "Apparel sizes", values: ["XS", "S", "M", "L", "XL", "XXL"] },
  { label: "Shoe sizes", values: ["38", "39", "40", "41", "42", "43", "44"] },
  { label: "Pack quantities", values: ["Single", "Pack of 2", "Pack of 4"] },
  { label: "Weights", values: ["250g", "500g", "1kg", "2kg"] },
] as const;

const OPTION_2_PRESETS = [
  { label: "Core colors", values: ["Black", "White", "Grey", "Navy"] },
  { label: "Primary colors", values: ["Red", "Blue", "Green", "Yellow"] },
  { label: "Finishes", values: ["Matte", "Gloss", "Satin"] },
  { label: "Styles", values: ["Classic", "Premium", "Gift Box"] },
] as const;

type EditableVariantFields = Pick<BulkGeneratedVariant, "sku" | "price" | "stock">;

export interface BulkVariantGeneratorDefaults {
  basePrice?: number;
  baseStock?: number;
  trackInventory?: boolean;
  baseWeight?: number | null;
  skuTemplate?: string;
  discountType?: "percentage" | "flat";
  discountValue?: number | null;
  generateBarcodes?: boolean;
  /** Required allocation when converting a tracked simple SKU into options. */
  sourceStock?: number;
}

interface BulkVariantGeneratorProps {
  productSlug?: string;
  existingVariants: ProductVariant[];
  onGenerate: (variants: BulkGeneratedVariant[]) => Promise<void>;
  disabled?: boolean;
  initialOpen?: boolean;
  optionLabels?: VariantOptionLabels;
  defaults?: BulkVariantGeneratorDefaults;
  triggerLabel?: string;
}

function createIdentitySeed(): string {
  return crypto.randomUUID();
}

function countCombinations(option1Values: string[], option2Values: string[]): number {
  if (option1Values.length === 0) return option2Values.length;
  if (option2Values.length === 0) return option1Values.length;
  return option1Values.length * option2Values.length;
}

export function BulkVariantGenerator({
  productSlug,
  existingVariants,
  onGenerate,
  disabled,
  initialOpen = false,
  optionLabels,
  defaults,
  triggerLabel = "Generate combinations",
}: BulkVariantGeneratorProps) {
  const { symbol } = useCurrency();
  const normalizedOptionLabels = normalizeVariantOptionLabels(optionLabels);
  const [open, setOpen] = useState(initialOpen);
  const [isGenerating, setIsGenerating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [option1Input, setOption1Input] = useState("");
  const [option1Values, setOption1Values] = useState<string[]>([]);
  const [option2Input, setOption2Input] = useState("");
  const [option2Values, setOption2Values] = useState<string[]>([]);
  const [basePrice, setBasePrice] = useState(defaults?.basePrice ?? 0);
  const [baseStock, setBaseStock] = useState(defaults?.baseStock ?? 0);
  const [trackInventory, setTrackInventory] = useState(
    defaults?.trackInventory ?? true,
  );
  const [baseWeight, setBaseWeight] = useState<number | null>(
    defaults?.baseWeight ?? null,
  );
  const [skuTemplate, setSkuTemplate] = useState(
    defaults?.skuTemplate ?? "{SLUG}-{OPTION1}-{OPTION2}",
  );
  const [discountType, setDiscountType] = useState<"percentage" | "flat">(
    defaults?.discountType ?? "percentage",
  );
  const [discountValue, setDiscountValue] = useState<number | null>(
    defaults?.discountValue ?? null,
  );
  const [generateBarcodes, setGenerateBarcodes] = useState(
    defaults?.generateBarcodes ?? false,
  );
  const [identitySeed, setIdentitySeed] = useState(createIdentitySeed);
  const [rowOverrides, setRowOverrides] = useState<
    Record<string, Partial<EditableVariantFields>>
  >({});
  const [excludedDraftKeys, setExcludedDraftKeys] = useState<Set<string>>(
    new Set(),
  );

  const activeOptionVariants = useMemo(
    () => existingVariants.filter(
      (variant) => !variant.isDefault && !variant.deletedAt,
    ),
    [existingVariants],
  );
  const existingTopology = useMemo(
    () => classifyProductVariantOptionAxes(activeOptionVariants),
    [activeOptionVariants],
  );
  const existingOption1Values = useMemo(
    () => Array.from(new Map(
      activeOptionVariants
        .filter((variant) => variant.size?.trim())
        .map((variant) => [normalizeVariantDraftIdentity(variant.size), variant.size!.trim()]),
    ).values()),
    [activeOptionVariants],
  );
  const existingOption2Values = useMemo(
    () => Array.from(new Map(
      activeOptionVariants
        .filter((variant) => variant.color?.trim())
        .map((variant) => [normalizeVariantDraftIdentity(variant.color), variant.color!.trim()]),
    ).values()),
    [activeOptionVariants],
  );
  const option1Presets = useMemo(
    () => existingOption1Values.length > 0
      ? [
          {
            label: `Existing ${normalizedOptionLabels.option1}`,
            values: existingOption1Values,
          },
          ...OPTION_1_PRESETS,
        ]
      : [...OPTION_1_PRESETS],
    [existingOption1Values, normalizedOptionLabels.option1],
  );
  const option2Presets = useMemo(
    () => existingOption2Values.length > 0
      ? [
          {
            label: `Existing ${normalizedOptionLabels.option2}`,
            values: existingOption2Values,
          },
          ...OPTION_2_PRESETS,
        ]
      : [...OPTION_2_PRESETS],
    [existingOption2Values, normalizedOptionLabels.option2],
  );

  const combinationCount = countCombinations(option1Values, option2Values);
  const exceedsLimit = combinationCount > MAX_PRODUCT_OPTION_COMBINATIONS;
  const generatedVariants = useMemo(() => {
    if (exceedsLimit) return [];
    const options: BulkVariantOptions = {
      option1Values,
      option2Values,
      basePrice,
      baseStock,
      trackInventory,
      baseWeight,
      skuTemplate,
      discountType,
      discountValue,
      generateBarcodes,
    };
    return generateVariantCombinations(options, productSlug, identitySeed);
  }, [
    basePrice,
    baseStock,
    baseWeight,
    discountType,
    discountValue,
    exceedsLimit,
    generateBarcodes,
    identitySeed,
    option1Values,
    option2Values,
    productSlug,
    skuTemplate,
    trackInventory,
  ]);

  const previewVariants = useMemo(
    () => generatedVariants.map((variant) => ({
      ...variant,
      ...(rowOverrides[getBulkVariantDraftKey(variant.size, variant.color)] ?? {}),
    })),
    [generatedVariants, rowOverrides],
  );
  const previewTopology = useMemo(
    () => classifyProductVariantOptionAxes(previewVariants),
    [previewVariants],
  );

  const conflictsByDraftKey = useMemo(() => {
    const existingSkuKeys = new Set(
      existingVariants.map((variant) => normalizeVariantDraftIdentity(variant.sku)),
    );
    const existingBarcodeKeys = new Set(
      existingVariants
        .map((variant) => normalizeVariantDraftIdentity(variant.barcode))
        .filter(Boolean),
    );
    const existingOptionKeys = new Set(
      existingVariants
        .filter((variant) => !variant.isDefault && !variant.deletedAt)
        .map((variant) => getBulkVariantDraftKey(variant.size, variant.color)),
    );
    const skuCounts = new Map<string, number>();
    const barcodeCounts = new Map<string, number>();

    for (const variant of previewVariants) {
      const skuKey = normalizeVariantDraftIdentity(variant.sku);
      skuCounts.set(skuKey, (skuCounts.get(skuKey) ?? 0) + 1);
      const barcodeKey = normalizeVariantDraftIdentity(variant.barcode);
      if (barcodeKey) {
        barcodeCounts.set(barcodeKey, (barcodeCounts.get(barcodeKey) ?? 0) + 1);
      }
    }

    const conflicts = new Map<string, string[]>();
    for (const variant of previewVariants) {
      const draftKey = getBulkVariantDraftKey(variant.size, variant.color);
      const rowConflicts: string[] = [];
      const skuKey = normalizeVariantDraftIdentity(variant.sku);
      const barcodeKey = normalizeVariantDraftIdentity(variant.barcode);
      if (skuKey.length < 3) rowConflicts.push("SKU too short");
      if (existingSkuKeys.has(skuKey)) rowConflicts.push("SKU exists");
      if ((skuCounts.get(skuKey) ?? 0) > 1) rowConflicts.push("Duplicate SKU");
      if (existingOptionKeys.has(draftKey)) rowConflicts.push("Option exists");
      if (barcodeKey && existingBarcodeKeys.has(barcodeKey)) {
        rowConflicts.push("Barcode exists");
      }
      if (barcodeKey && (barcodeCounts.get(barcodeKey) ?? 0) > 1) {
        rowConflicts.push("Duplicate barcode");
      }
      if (!Number.isFinite(variant.price) || variant.price < 0) {
        rowConflicts.push("Invalid price");
      }
      if (!Number.isInteger(variant.stock) || variant.stock < 0) {
        rowConflicts.push("Invalid stock");
      }
      if ((variant.size?.trim().length ?? 0) > 50 || (variant.color?.trim().length ?? 0) > 50) {
        rowConflicts.push("Value too long");
      }
      if (existingTopology === "mixed") {
        rowConflicts.push("Existing option shape needs repair");
      } else if (
        existingTopology !== "none" &&
        previewTopology !== "none" &&
        previewTopology !== existingTopology
      ) {
        rowConflicts.push("Use the existing option shape");
      }
      conflicts.set(draftKey, rowConflicts);
    }
    return conflicts;
  }, [existingTopology, existingVariants, previewTopology, previewVariants]);

  const includedVariants = useMemo(
    () => previewVariants.filter(
      (variant) => !excludedDraftKeys.has(getBulkVariantDraftKey(variant.size, variant.color)),
    ),
    [excludedDraftKeys, previewVariants],
  );
  const allocatedTrackedStock = includedVariants.reduce(
    (total, variant) => total + (variant.trackInventory === false ? 0 : variant.stock),
    0,
  );
  const stockAllocationError =
    defaults?.sourceStock !== undefined &&
    allocatedTrackedStock !== defaults.sourceStock
      ? `Allocate exactly ${defaults.sourceStock} on-hand units across the selected options. Currently allocated: ${allocatedTrackedStock}.`
      : null;
  const includedHasConflicts = includedVariants.some(
    (variant) =>
      (conflictsByDraftKey.get(getBulkVariantDraftKey(variant.size, variant.color))?.length ?? 0) > 0,
  );
  const skuTemplateValidation = useMemo(
    () => validateSkuTemplate(skuTemplate),
    [skuTemplate],
  );
  const defaultsValidationError = useMemo(() => {
    if (!Number.isFinite(basePrice) || basePrice < 0) return "Base price cannot be negative.";
    if (!Number.isInteger(baseStock) || baseStock < 0) return "Base stock must be a non-negative whole number.";
    if (baseWeight !== null && (!Number.isFinite(baseWeight) || baseWeight < 0)) {
      return "Weight cannot be negative.";
    }
    if (discountValue !== null && (!Number.isFinite(discountValue) || discountValue < 0)) {
      return "Discount cannot be negative.";
    }
    if (discountType === "percentage" && (discountValue ?? 0) > 100) {
      return "Percentage discount cannot exceed 100%.";
    }
    return null;
  }, [basePrice, baseStock, baseWeight, discountType, discountValue]);

  const handleVariantChange = (
    draftKey: string,
    changes: Partial<EditableVariantFields>,
  ) => {
    setSubmitError(null);
    setRowOverrides((current) => ({
      ...current,
      [draftKey]: { ...current[draftKey], ...changes },
    }));
  };

  const handleIncludedChange = (draftKey: string, included: boolean) => {
    setSubmitError(null);
    setExcludedDraftKeys((current) => {
      const next = new Set(current);
      if (included) next.delete(draftKey);
      else next.add(draftKey);
      return next;
    });
  };

  const regenerateIdentities = () => {
    setIdentitySeed(createIdentitySeed());
    setRowOverrides((current) => Object.fromEntries(
      Object.entries(current).map(([draftKey, changes]) => {
        const { sku: _sku, ...preserved } = changes;
        return [draftKey, preserved];
      }),
    ));
    setSubmitError(null);
  };

  const resetAfterSuccess = () => {
    setOption1Values([]);
    setOption2Values([]);
    setOption1Input("");
    setOption2Input("");
    setRowOverrides({});
    setExcludedDraftKeys(new Set());
    setSubmitError(null);
    setIdentitySeed(createIdentitySeed());
  };

  const handleGenerate = async () => {
    if (
      includedVariants.length === 0 ||
      includedHasConflicts ||
      exceedsLimit ||
      !skuTemplateValidation.valid ||
      defaultsValidationError !== null ||
      stockAllocationError !== null
    ) return;

    setIsGenerating(true);
    setSubmitError(null);
    try {
      await onGenerate(includedVariants);
      resetAfterSuccess();
      setOpen(false);
    } catch (error: unknown) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Options were not created. Review the draft and try again.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const canGenerate =
    includedVariants.length > 0 &&
    !includedHasConflicts &&
    !exceedsLimit &&
    skuTemplateValidation.valid &&
    defaultsValidationError === null &&
    stockAllocationError === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isGenerating) setOpen(nextOpen);
        if (nextOpen) setSubmitError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="text-lg font-semibold">Generate option combinations</DialogTitle>
          <DialogDescription className="text-xs leading-5">
            Combine any {normalizedOptionLabels.option1} and {normalizedOptionLabels.option2}
            values, review the resulting SKUs, then create only the rows you select.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(330px,0.82fr)_minmax(0,1.18fr)]">
          <div className="space-y-4 border-b p-4 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">1. Values</h3>
                <p className="text-[11px] text-muted-foreground">
                  {combinationCount} combination{combinationCount === 1 ? "" : "s"}
                </p>
              </div>
              {previewVariants.length > 0 && (generateBarcodes || skuTemplate.includes("{RANDOM}")) ? (
                <Button type="button" variant="ghost" size="sm" onClick={regenerateIdentities} className="h-7 px-2 text-[11px]">
                  <RefreshCw className="mr-1 h-3 w-3" />
                  Regenerate IDs
                </Button>
              ) : null}
            </div>

            <VariantAttributeInput
              id="option-1-values"
              label={`${normalizedOptionLabels.option1} values`}
              items={option1Values}
              onItemsChange={setOption1Values}
              inputValue={option1Input}
              onInputValueChange={setOption1Input}
              placeholder={`Add ${normalizedOptionLabels.option1.toLowerCase()} values`}
              emptyMessage={`No ${normalizedOptionLabels.option1} values yet.`}
              quickAddOptions={option1Presets}
            />

            <VariantAttributeInput
              id="option-2-values"
              label={`${normalizedOptionLabels.option2} values`}
              items={option2Values}
              onItemsChange={setOption2Values}
              inputValue={option2Input}
              onInputValueChange={setOption2Input}
              placeholder={`Add ${normalizedOptionLabels.option2.toLowerCase()} values`}
              emptyMessage={`No ${normalizedOptionLabels.option2} values yet.`}
              quickAddOptions={option2Presets}
            />

            {exceedsLimit ? (
              <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                Reduce this matrix to {MAX_PRODUCT_OPTION_COMBINATIONS} options or fewer.
                Use CSV import for a larger prepared catalog change.
              </div>
            ) : null}

            {defaultsValidationError ? (
              <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {defaultsValidationError}
              </div>
            ) : null}

            {stockAllocationError ? (
              <div role="alert" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {stockAllocationError}
              </div>
            ) : null}

            <div className="space-y-3 border-t pt-4">
              <div>
                <h3 className="text-sm font-semibold">2. Defaults</h3>
                <p className="text-[11px] text-muted-foreground">
                  Applied to every new row unless you edit it in Review.
                </p>
              </div>
              <VariantConfigSection
                basePrice={basePrice}
                onBasePriceChange={setBasePrice}
                baseStock={baseStock}
                onBaseStockChange={setBaseStock}
                trackInventory={trackInventory}
                onTrackInventoryChange={setTrackInventory}
                lockInventoryTracking={defaults?.sourceStock !== undefined}
                baseWeight={baseWeight}
                onBaseWeightChange={setBaseWeight}
                discountType={discountType}
                onDiscountTypeChange={setDiscountType}
                discountValue={discountValue}
                onDiscountValueChange={setDiscountValue}
                skuTemplate={skuTemplate}
                onSkuTemplateChange={setSkuTemplate}
                generateBarcodes={generateBarcodes}
                onGenerateBarcodesChange={setGenerateBarcodes}
                productSlug={productSlug}
                symbol={symbol}
              />
            </div>
          </div>

          <div className="min-w-0 space-y-3 p-4">
            <div>
              <h3 className="text-sm font-semibold">3. Review</h3>
              <p className="text-[11px] text-muted-foreground">
                Edit SKU, price, and stock inline. Clear Create to omit a row.
              </p>
            </div>
            <VariantPreviewTable
              previewVariants={previewVariants}
              conflictsByDraftKey={conflictsByDraftKey}
              excludedDraftKeys={excludedDraftKeys}
              generateBarcodes={generateBarcodes}
              symbol={symbol}
              optionLabels={normalizedOptionLabels}
              hasRowEdits={Object.keys(rowOverrides).length > 0}
              onVariantChange={handleVariantChange}
              onIncludedChange={handleIncludedChange}
              onResetEdits={() => setRowOverrides({})}
            />
          </div>
        </div>

        {submitError ? (
          <div role="alert" className="mx-4 mt-3 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {submitError}
          </div>
        ) : null}

        <DialogFooter className="border-t px-4 py-3 sm:justify-between">
          <p className="hidden self-center text-[11px] text-muted-foreground sm:block">
            Identities stay stable while this draft is open.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isGenerating}>
              Cancel
            </Button>
            <Button type="button" onClick={handleGenerate} disabled={!canGenerate || isGenerating} className="min-w-[150px]">
              {isGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {isGenerating ? "Creating…" : `Create ${includedVariants.length} option${includedVariants.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
