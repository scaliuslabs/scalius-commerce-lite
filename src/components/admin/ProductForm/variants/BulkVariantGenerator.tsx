// src/components/admin/ProductForm/variants/BulkVariantGenerator.tsx

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles, X } from "lucide-react";
import { SkuTemplateConfig } from "./SkuTemplateConfig";
import { generateVariantCombinations } from "./utils/variantHelpers";
import type {
  BulkVariantOptions,
  BulkGeneratedVariant,
  ProductVariant,
} from "./types";

interface BulkVariantGeneratorProps {
  productSlug?: string;
  existingVariants: ProductVariant[];
  onGenerate: (variants: BulkGeneratedVariant[]) => Promise<void>;
  disabled?: boolean;
}

export function BulkVariantGenerator({
  productSlug,
  existingVariants,
  onGenerate,
  disabled,
}: BulkVariantGeneratorProps) {
  const [open, setOpen] = useState(false);
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

  // Generate preview
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
    productSlug,
  ]);

  // Check for SKU conflicts
  const existingSkus = useMemo(
    () => new Set(existingVariants.map((v) => v.sku)),
    [existingVariants],
  );

  const skuConflicts = useMemo(
    () => previewVariants.filter((v) => existingSkus.has(v.sku)),
    [previewVariants, existingSkus],
  );

  const handleAddSize = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && sizeInput.trim()) {
      e.preventDefault();
      if (!sizes.includes(sizeInput.trim())) {
        setSizes([...sizes, sizeInput.trim()]);
      }
      setSizeInput("");
    }
  };

  const handleRemoveSize = (size: string) => {
    setSizes(sizes.filter((s) => s !== size));
  };

  const handleRemoveColor = (color: string) => {
    setColors(colors.filter((c) => c !== color));
  };

  const handleGenerate = async () => {
    if (skuConflicts.length > 0) {
      return; // Don't allow generation if there are conflicts
    }

    setIsGenerating(true);
    try {
      await onGenerate(previewVariants);
      // Reset form
      setSizes([]);
      setColors([]);
      setBasePrice(0);
      setBaseStock(0);
      setBaseWeight(null);
      setDiscountValue(null);
      setOpen(false);
    } catch (error) {
      console.error("Failed to generate variants:", error);
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
            Bulk Variant Generator
          </DialogTitle>
          <DialogDescription className="text-base mt-2">
            Generate multiple variants at once by combining sizes and colors.
            All combinations will be created automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-10 py-6">
          {/* Left Column - Configuration */}
          <div className="space-y-5">
            <div className="space-y-2.5">
              <Label htmlFor="sizes" className="text-sm font-semibold">
                Sizes
              </Label>
              <Input
                id="sizes"
                value={sizeInput}
                onChange={(e) => setSizeInput(e.target.value)}
                onKeyDown={handleAddSize}
                placeholder="Type size and press Enter (e.g., S, M, L, XL)"
                className="h-10"
              />
              {sizes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {sizes.map((size) => (
                    <Badge
                      key={size}
                      variant="secondary"
                      className="gap-1 px-2.5 py-1"
                    >
                      {size}
                      <button
                        type="button"
                        onClick={() => handleRemoveSize(size)}
                        className="ml-1 hover:text-destructive transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Sizes Section */}
            <div className="space-y-3 bg-muted/20 p-4 rounded-lg border">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="sizes"
                  className="text-sm font-semibold flex items-center gap-2"
                >
                  Sizes
                  <Badge
                    variant="outline"
                    className="text-[10px] font-normal h-5"
                  >
                    {sizes.length} added
                  </Badge>
                </Label>
                <div className="flex items-center gap-2">
                  {sizes.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSizes([])}
                      className="h-6 text-[10px] text-muted-foreground hover:text-destructive px-2"
                    >
                      Clear All
                    </Button>
                  )}
                  <Select
                    onValueChange={(val) => {
                      const newSizes = val.split(",");
                      const combined = [...new Set([...sizes, ...newSizes])];
                      setSizes(combined);
                    }}
                  >
                    <SelectTrigger className="h-7 text-[10px] w-[110px] border-dashed">
                      <SelectValue placeholder="Quick Add..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="S,M,L,XL,XXL">
                        Standard (S-XXL)
                      </SelectItem>
                      <SelectItem value="XS,S,M,L,XL">
                        Extended (XS-XL)
                      </SelectItem>
                      <SelectItem value="38,39,40,41,42,43,44">
                        Shoes (38-44)
                      </SelectItem>
                      <SelectItem value="2Y,4Y,6Y,8Y,10Y,12Y">
                        Kids (2Y-12Y)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Input
                id="sizes"
                value={sizeInput}
                onPaste={(e) => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData("text");
                  if (!pasted) return;
                  const newItems = pasted
                    .split(/[\n,]+/) // Split by comma or newline
                    .map((s) => s.trim())
                    .filter((s) => s !== "" && !sizes.includes(s));

                  if (newItems.length > 0) {
                    setSizes([...sizes, ...newItems]);
                  }
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.includes(",")) {
                    const parts = val.split(",").map((s) => s.trim());
                    const lastPart = parts.pop() || "";
                    const newItems = parts.filter(
                      (p) => p !== "" && !sizes.includes(p),
                    );
                    if (newItems.length > 0) {
                      setSizes([...sizes, ...newItems]);
                    }
                    setSizeInput(lastPart);
                  } else {
                    setSizeInput(val);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && sizeInput.trim()) {
                    e.preventDefault();
                    if (!sizes.includes(sizeInput.trim())) {
                      setSizes([...sizes, sizeInput.trim()]);
                    }
                    setSizeInput("");
                  }
                }}
                placeholder="Type size and press Enter. Paste comma-separated lists supported."
                className="h-10 bg-background"
              />

              {sizes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 min-h-6">
                  {sizes.map((size) => (
                    <Badge
                      key={size}
                      variant="secondary"
                      className="gap-1 pl-2.5 pr-1 py-0.5 text-sm"
                    >
                      {size}
                      <button
                        type="button"
                        onClick={() => handleRemoveSize(size)}
                        className="ml-1 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-destructive hover:text-destructive-foreground transition-colors p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground italic pl-1">
                  No sizes added yet. Paste a list (e.g. S,M,L) or use Quick
                  Add.
                </p>
              )}
            </div>

            {/* Colors Section */}
            <div className="space-y-3 bg-muted/20 p-4 rounded-lg border">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="colors"
                  className="text-sm font-semibold flex items-center gap-2"
                >
                  Colors
                  <Badge
                    variant="outline"
                    className="text-[10px] font-normal h-5"
                  >
                    {colors.length} added
                  </Badge>
                </Label>
                <div className="flex items-center gap-2">
                  {colors.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setColors([])}
                      className="h-6 text-[10px] text-muted-foreground hover:text-destructive px-2"
                    >
                      Clear All
                    </Button>
                  )}
                  <Select
                    onValueChange={(val) => {
                      const newColors = val.split(",");
                      const combined = [...new Set([...colors, ...newColors])];
                      setColors(combined);
                    }}
                  >
                    <SelectTrigger className="h-7 text-[10px] w-[110px] border-dashed">
                      <SelectValue placeholder="Quick Add..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Black,White,Grey,Navy">
                        Basics
                      </SelectItem>
                      <SelectItem value="Red,Blue,Green,Yellow">
                        Primary
                      </SelectItem>
                      <SelectItem value="Pastel Pink,Pastel Blue,Mint,Cream">
                        Pastels
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Input
                id="colors"
                value={colorInput}
                onPaste={(e) => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData("text");
                  if (!pasted) return;
                  const newItems = pasted
                    .split(/[\n,]+/)
                    .map((s) => s.trim())
                    .filter((s) => s !== "" && !colors.includes(s));

                  if (newItems.length > 0) {
                    setColors([...colors, ...newItems]);
                  }
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.includes(",")) {
                    const parts = val.split(",").map((s) => s.trim());
                    const lastPart = parts.pop() || "";
                    const newItems = parts.filter(
                      (p) => p !== "" && !colors.includes(p),
                    );
                    if (newItems.length > 0) {
                      setColors([...colors, ...newItems]);
                    }
                    setColorInput(lastPart);
                  } else {
                    setColorInput(val);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && colorInput.trim()) {
                    e.preventDefault();
                    if (!colors.includes(colorInput.trim())) {
                      setColors([...colors, colorInput.trim()]);
                    }
                    setColorInput("");
                  }
                }}
                placeholder="Type color and press Enter. Paste supported."
                className="h-10 bg-background"
              />

              {colors.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 min-h-6">
                  {colors.map((color) => (
                    <Badge
                      key={color}
                      variant="secondary"
                      className="gap-1 pl-2.5 pr-1 py-0.5 text-sm"
                    >
                      {color}
                      <button
                        type="button"
                        onClick={() => handleRemoveColor(color)}
                        className="ml-1 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-destructive hover:text-destructive-foreground transition-colors p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground italic pl-1">
                  No colors added yet.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2.5">
                <Label htmlFor="price" className="text-sm font-semibold">
                  Base Price
                </Label>
                <Input
                  id="price"
                  type="number"
                  value={basePrice === 0 ? "" : basePrice}
                  onChange={(e) =>
                    setBasePrice(
                      e.target.value ? parseFloat(e.target.value) : 0,
                    )
                  }
                  min="0"
                  step="0.01"
                  className="h-10"
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-2.5">
                <Label htmlFor="stock" className="text-sm font-semibold">
                  Base Stock
                </Label>
                <Input
                  id="stock"
                  type="number"
                  value={baseStock === 0 ? "" : baseStock}
                  onChange={(e) =>
                    setBaseStock(
                      e.target.value ? parseInt(e.target.value, 10) : 0,
                    )
                  }
                  min="0"
                  className="h-10"
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-2.5">
              <Label htmlFor="weight" className="text-sm font-medium">
                Weight (grams, optional)
              </Label>
              <Input
                id="weight"
                type="number"
                value={baseWeight ?? ""}
                onChange={(e) =>
                  setBaseWeight(
                    e.target.value ? parseFloat(e.target.value) : null,
                  )
                }
                min="0"
                placeholder="Optional"
                className="h-10"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2.5">
                <Label htmlFor="discount-type" className="text-sm font-medium">
                  Discount Type
                </Label>
                <Select
                  value={discountType}
                  onValueChange={(v: "percentage" | "flat") =>
                    setDiscountType(v)
                  }
                >
                  <SelectTrigger id="discount-type" className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage (%)</SelectItem>
                    <SelectItem value="flat">Flat Amount (৳)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2.5">
                <Label htmlFor="discount-value" className="text-sm font-medium">
                  Discount Value
                </Label>
                <Input
                  id="discount-value"
                  type="number"
                  value={discountValue ?? ""}
                  onChange={(e) =>
                    setDiscountValue(
                      e.target.value ? parseFloat(e.target.value) : null,
                    )
                  }
                  min="0"
                  max={discountType === "percentage" ? 100 : undefined}
                  placeholder="Optional"
                  className="h-10"
                />
              </div>
            </div>

            <div className="pt-1">
              <SkuTemplateConfig
                value={skuTemplate}
                onChange={setSkuTemplate}
                productSlug={productSlug}
              />
            </div>
          </div>

          {/* Right Column - Preview */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">
                Preview ({previewVariants.length} variant
                {previewVariants.length !== 1 ? "s" : ""})
              </Label>
              {skuConflicts.length > 0 && (
                <Badge variant="destructive" className="text-xs px-2 py-0.5">
                  {skuConflicts.length} SKU conflict
                  {skuConflicts.length > 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            <div className="border rounded-lg shadow-sm overflow-hidden max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader className="bg-muted/50 sticky top-0">
                  <TableRow className="hover:bg-muted/50">
                    <TableHead className="font-semibold">SKU</TableHead>
                    <TableHead className="font-semibold">Size</TableHead>
                    <TableHead className="font-semibold">Color</TableHead>
                    <TableHead className="text-right font-semibold">
                      Price
                    </TableHead>
                    <TableHead className="text-right font-semibold">
                      Stock
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewVariants.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-32 text-center">
                        <div className="text-muted-foreground">
                          <p className="text-sm">
                            Add sizes and/or colors to preview variants
                          </p>
                          <p className="text-xs mt-1">
                            All combinations will be shown here
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    previewVariants.map((variant, index) => {
                      const hasConflict = existingSkus.has(variant.sku);
                      return (
                        <TableRow
                          key={index}
                          className={
                            hasConflict
                              ? "bg-destructive/10 hover:bg-destructive/15"
                              : "hover:bg-muted/30"
                          }
                        >
                          <TableCell className="font-mono text-sm">
                            {variant.sku}
                            {hasConflict && (
                              <Badge
                                variant="destructive"
                                className="ml-2 text-[10px] px-1.5 py-0"
                              >
                                Exists
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {variant.size || "—"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {variant.color || "—"}
                          </TableCell>
                          <TableCell className="text-right text-sm font-medium">
                            ৳{variant.price.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {variant.stock}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
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
            {isGenerating && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
            {isGenerating
              ? "Generating..."
              : `Generate ${previewVariants.length} Variant${previewVariants.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
