import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Barcode, ChevronDown, SlidersHorizontal } from "lucide-react";
import { SkuTemplateConfig } from "../SkuTemplateConfig";

interface VariantConfigSectionProps {
  basePrice: number;
  onBasePriceChange: (value: number) => void;
  baseStock: number;
  onBaseStockChange: (value: number) => void;
  trackInventory: boolean;
  onTrackInventoryChange: (value: boolean) => void;
  lockInventoryTracking?: boolean;
  baseWeight: number | null;
  onBaseWeightChange: (value: number | null) => void;
  discountType: "percentage" | "flat";
  onDiscountTypeChange: (value: "percentage" | "flat") => void;
  discountValue: number | null;
  onDiscountValueChange: (value: number | null) => void;
  skuTemplate: string;
  onSkuTemplateChange: (value: string) => void;
  generateBarcodes: boolean;
  onGenerateBarcodesChange: (value: boolean) => void;
  productSlug?: string;
  symbol: string;
}

export const VariantConfigSection = React.memo(
  function VariantConfigSection({
    basePrice,
    onBasePriceChange,
    baseStock,
    onBaseStockChange,
    trackInventory,
    onTrackInventoryChange,
    lockInventoryTracking = false,
    baseWeight,
    onBaseWeightChange,
    discountType,
    onDiscountTypeChange,
    discountValue,
    onDiscountValueChange,
    skuTemplate,
    onSkuTemplateChange,
    generateBarcodes,
    onGenerateBarcodesChange,
    productSlug,
    symbol,
  }: VariantConfigSectionProps) {
    return (
      <>
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
                onBasePriceChange(
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
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="stock" className="text-sm font-semibold">
                Base Stock
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Track</span>
                <Switch
                  checked={trackInventory}
                  onCheckedChange={onTrackInventoryChange}
                  disabled={lockInventoryTracking}
                  aria-label="Track stock for generated options"
                />
              </div>
            </div>
            {trackInventory ? (
              <div className="space-y-1">
                <Input
                  id="stock"
                  type="number"
                  value={baseStock === 0 ? "" : baseStock}
                  onChange={(e) =>
                    onBaseStockChange(
                      e.target.value ? parseInt(e.target.value, 10) : 0,
                    )
                  }
                  min="0"
                  className="h-10"
                  placeholder="0"
                />
                {lockInventoryTracking ? (
                  <p className="text-[10px] leading-4 text-muted-foreground">
                    Tracking stays on while existing stock is allocated.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="flex h-10 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                No stock limit
              </div>
            )}
          </div>
        </div>

        <details className="group rounded-lg border bg-muted/10">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              More defaults
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>

          <div className="space-y-4 border-t px-3 py-3">
            <div className="space-y-2">
              <Label htmlFor="weight" className="text-sm font-medium">
                Weight (grams)
              </Label>
              <Input
                id="weight"
                type="number"
                value={baseWeight ?? ""}
                onChange={(e) =>
                  onBaseWeightChange(
                    e.target.value ? parseFloat(e.target.value) : null,
                  )
                }
                min="0"
                placeholder="Optional"
                className="h-9"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="discount-type" className="text-sm font-medium">
                  Discount type
                </Label>
                <Select
                  value={discountType}
                  onValueChange={(v: "percentage" | "flat") =>
                    onDiscountTypeChange(v)
                  }
                >
                  <SelectTrigger id="discount-type" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage (%)</SelectItem>
                    <SelectItem value="flat">Flat amount ({symbol})</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="discount-value" className="text-sm font-medium">
                  Discount value
                </Label>
                <Input
                  id="discount-value"
                  type="number"
                  value={discountValue ?? ""}
                  onChange={(e) =>
                    onDiscountValueChange(
                      e.target.value ? parseFloat(e.target.value) : null,
                    )
                  }
                  min="0"
                  max={discountType === "percentage" ? 100 : undefined}
                  placeholder="Optional"
                  className="h-9"
                />
              </div>
            </div>

            <SkuTemplateConfig
              value={skuTemplate}
              onChange={onSkuTemplateChange}
              productSlug={productSlug}
            />

            <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
              <Checkbox
                id="generate-barcodes"
                checked={generateBarcodes}
                onCheckedChange={(checked) => onGenerateBarcodesChange(!!checked)}
              />
              <div>
                <label
                  htmlFor="generate-barcodes"
                  className="flex cursor-pointer items-center gap-2 text-sm font-medium"
                >
                  <Barcode className="h-4 w-4" />
                  Generate internal EAN-13 barcodes
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Stable while this draft stays open; regenerate only by request.
                </p>
              </div>
            </div>
          </div>
        </details>
      </>
    );
  },
);
