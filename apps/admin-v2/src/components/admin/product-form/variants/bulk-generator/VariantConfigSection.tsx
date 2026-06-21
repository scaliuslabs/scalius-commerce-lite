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
import { Barcode } from "lucide-react";
import { SkuTemplateConfig } from "../SkuTemplateConfig";

interface VariantConfigSectionProps {
  basePrice: number;
  onBasePriceChange: (value: number) => void;
  baseStock: number;
  onBaseStockChange: (value: number) => void;
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
            <Label htmlFor="stock" className="text-sm font-semibold">
              Base Stock
            </Label>
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
              onBaseWeightChange(
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
                onDiscountTypeChange(v)
              }
            >
              <SelectTrigger id="discount-type" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage">Percentage (%)</SelectItem>
                <SelectItem value="flat">Flat Amount ({symbol})</SelectItem>
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
                onDiscountValueChange(
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
            onChange={onSkuTemplateChange}
            productSlug={productSlug}
          />
        </div>

        <div className="flex items-center gap-3 p-3 bg-muted/20 rounded-lg border">
          <Checkbox
            id="generate-barcodes"
            checked={generateBarcodes}
            onCheckedChange={(checked) => onGenerateBarcodesChange(!!checked)}
          />
          <div>
            <label
              htmlFor="generate-barcodes"
              className="text-sm font-medium cursor-pointer flex items-center gap-2"
            >
              <Barcode className="h-4 w-4" />
              Auto-generate EAN-13 barcodes
            </label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Each option gets a unique barcode for scanning and label printing
            </p>
          </div>
        </div>
      </>
    );
  },
);
