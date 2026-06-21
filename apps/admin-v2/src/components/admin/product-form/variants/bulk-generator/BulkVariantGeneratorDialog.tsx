import { useState, useMemo } from "react";
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
import { Loader2, Sparkles } from "lucide-react";
import { generateVariantCombinations } from "../utils/variantHelpers";
import type {
  BulkVariantOptions,
  BulkGeneratedVariant,
  ProductVariant,
} from "../types";
import { VariantAttributeInput } from "./VariantAttributeInput";
import { VariantConfigSection } from "./VariantConfigSection";
import { VariantPreviewTable } from "./VariantPreviewTable";

const SIZE_QUICK_ADD = [
  { label: "Standard (S-XXL)", value: "S,M,L,XL,XXL" },
  { label: "Extended (XS-XL)", value: "XS,S,M,L,XL" },
  { label: "Shoes (38-44)", value: "38,39,40,41,42,43,44" },
  { label: "Kids (2Y-12Y)", value: "2Y,4Y,6Y,8Y,10Y,12Y" },
] as const;

const COLOR_QUICK_ADD = [
  { label: "Basics", value: "Black,White,Grey,Navy" },
  { label: "Primary", value: "Red,Blue,Green,Yellow" },
  { label: "Pastels", value: "Pastel Pink,Pastel Blue,Mint,Cream" },
] as const;

interface BulkVariantGeneratorProps {
  productSlug?: string;
  existingVariants: ProductVariant[];
  onGenerate: (variants: BulkGeneratedVariant[]) => Promise<void>;
  disabled?: boolean;
  initialOpen?: boolean;
}

export function BulkVariantGenerator({
  productSlug,
  existingVariants,
  onGenerate,
  disabled,
  initialOpen = false,
}: BulkVariantGeneratorProps) {
  const { symbol } = useCurrency();
  const [open, setOpen] = useState(initialOpen);
  const [isGenerating, setIsGenerating] = useState(false);

  // Form state
  const [sizeInput, setSizeInput] = useState("");
  const [sizes, setSizes] = useState<string[]>([]);
  const [colorInput, setColorInput] = useState("");
  const [colors, setColors] = useState<string[]>([]);
  const [basePrice, setBasePrice] = useState<number>(0);
  const [baseStock, setBaseStock] = useState<number>(0);
  const [baseWeight, setBaseWeight] = useState<number | null>(null);
  const [skuTemplate, setSkuTemplate] = useState("{RANDOM}-{SIZE}-{COLOR}");
  const [discountType, setDiscountType] = useState<"percentage" | "flat">(
    "percentage",
  );
  const [discountValue, setDiscountValue] = useState<number | null>(null);
  const [generateBarcodes, setGenerateBarcodes] = useState(true);

  const previewVariants = useMemo(() => {
    const options: BulkVariantOptions = {
      sizes,
      colors,
      basePrice,
      baseStock,
      baseWeight,
      skuTemplate,
      discountType,
      discountValue,
      generateBarcodes,
    };
    return generateVariantCombinations(options, productSlug);
  }, [
    sizes,
    colors,
    basePrice,
    baseStock,
    baseWeight,
    skuTemplate,
    discountType,
    discountValue,
    generateBarcodes,
    productSlug,
  ]);

  const existingSkus = useMemo(
    () => new Set(existingVariants.map((v) => v.sku)),
    [existingVariants],
  );

  const skuConflicts = useMemo(
    () => previewVariants.filter((v) => existingSkus.has(v.sku)),
    [previewVariants, existingSkus],
  );

  const handleGenerate = async () => {
    if (skuConflicts.length > 0) return;

    setIsGenerating(true);
    try {
      await onGenerate(previewVariants);
      setSizes([]);
      setColors([]);
      setBasePrice(0);
      setBaseStock(0);
      setBaseWeight(null);
      setDiscountValue(null);
      setOpen(false);
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Failed to generate options:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const canGenerate = previewVariants.length > 0 && skuConflicts.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Sparkles className="mr-2 h-4 w-4" />
          Bulk Generate
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">
            Bulk Option Generator
          </DialogTitle>
          <DialogDescription className="text-base mt-2">
            Generate multiple options at once by combining sizes and colors.
            All combinations will be created automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-10 py-6">
          {/* Left Column - Configuration */}
          <div className="space-y-5">
            <VariantAttributeInput
              id="sizes"
              label="Sizes"
              items={sizes}
              onItemsChange={setSizes}
              inputValue={sizeInput}
              onInputValueChange={setSizeInput}
              placeholder="Type size and press Enter. Paste comma-separated lists supported."
              emptyMessage="No sizes added yet. Paste a list (e.g. S,M,L) or use Quick Add."
              quickAddOptions={[...SIZE_QUICK_ADD]}
            />

            <VariantAttributeInput
              id="colors"
              label="Colors"
              items={colors}
              onItemsChange={setColors}
              inputValue={colorInput}
              onInputValueChange={setColorInput}
              placeholder="Type color and press Enter. Paste supported."
              emptyMessage="No colors added yet."
              quickAddOptions={[...COLOR_QUICK_ADD]}
            />

            <VariantConfigSection
              basePrice={basePrice}
              onBasePriceChange={setBasePrice}
              baseStock={baseStock}
              onBaseStockChange={setBaseStock}
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

          {/* Right Column - Preview */}
          <VariantPreviewTable
            previewVariants={previewVariants}
            existingSkus={existingSkus}
            skuConflicts={skuConflicts}
            generateBarcodes={generateBarcodes}
            symbol={symbol}
          />
        </div>

        <DialogFooter className="gap-3">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isGenerating}
            size="lg"
          >
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={!canGenerate || isGenerating}
            size="lg"
            className="min-w-[200px]"
          >
            {isGenerating && (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            )}
            {isGenerating
              ? "Generating..."
              : `Generate ${previewVariants.length} Option${previewVariants.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
