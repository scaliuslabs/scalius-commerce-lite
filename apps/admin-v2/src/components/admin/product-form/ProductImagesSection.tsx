// src/components/admin/product-form/ProductImagesSection.tsx
import React, { lazy, memo, Suspense } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, ImagePlus, Info, Plus } from "lucide-react";
import { MediaManager } from "../media-manager";
import { Button } from "@/components/ui/button";
import { cn } from "@scalius/shared/utils";
import type {
  ProductFormValues,
  ProductVariantImageMappingFormValue,
} from "./types";
import { toast } from "sonner";
import {
  reconcileVariantImageMappings,
  type VariantImageAxis,
} from "./utils";
import {
  normalizeVariantOptionLabels,
  type VariantOptionLabels,
} from "./variants/types";

const DraggableImageGallery = lazy(() =>
  import("../DraggableImageGallery").then((module) => ({
    default: module.DraggableImageGallery,
  })),
);

interface ProductImagesSectionProps {
  form: UseFormReturn<ProductFormValues>;
  enableVariantImages: boolean;
  setEnableVariantImages: (enabled: boolean) => void;
  variantImageAxis: VariantImageAxis;
  setVariantImageAxis: (axis: VariantImageAxis) => void;
  uniqueOptionOneValues: string[];
  uniqueOptionTwoValues: string[];
  optionLabels?: VariantOptionLabels;
  variantImageMappings: ProductVariantImageMappingFormValue[];
  setVariantImageMappings: (mappings: ProductVariantImageMappingFormValue[]) => void;
  activeVariantIds: string[];
}

export const ProductImagesSection = memo(function ProductImagesSection({
  form,
  enableVariantImages,
  setEnableVariantImages,
  variantImageAxis,
  setVariantImageAxis,
  uniqueOptionOneValues,
  uniqueOptionTwoValues,
  optionLabels,
  variantImageMappings,
  setVariantImageMappings,
  activeVariantIds,
}: ProductImagesSectionProps) {
  const [isOpen, setIsOpen] = React.useState(true);
  const imageCount = form.watch("images")?.length ?? 0;
  const normalizedOptionLabels = React.useMemo(
    () => normalizeVariantOptionLabels(optionLabels),
    [optionLabels],
  );
  const variantImageOptions =
    variantImageAxis === "option1" ? uniqueOptionOneValues : uniqueOptionTwoValues;
  const hasVariantImageOptions =
    uniqueOptionOneValues.length > 0 || uniqueOptionTwoValues.length > 0;
  const axisLabel =
    variantImageAxis === "option1"
      ? `${normalizedOptionLabels.option1} values`
      : `${normalizedOptionLabels.option2} values`;
  const variantImageAxisLabel =
    variantImageAxis === "option1"
      ? normalizedOptionLabels.option1
      : normalizedOptionLabels.option2;
  const variantImageMappingByImageId = React.useMemo(
    () => Object.fromEntries(variantImageMappings.map((mapping) => [
      mapping.imageId,
      mapping.optionValue || (mapping.variantId ? "SKU image" : ""),
    ])),
    [variantImageMappings],
  );

  const reconcileMappingsForImages = React.useCallback((
    images: ProductFormValues["images"],
    fillMissing: boolean,
  ) => {
    setVariantImageMappings(reconcileVariantImageMappings({
      mappings: variantImageMappings,
      images,
      axis: variantImageAxis,
      optionValues: variantImageOptions,
      variantIds: activeVariantIds,
      fillMissing,
    }));
  }, [activeVariantIds, setVariantImageMappings, variantImageAxis, variantImageMappings, variantImageOptions]);

  React.useEffect(() => {
    if (
      variantImageAxis === "option2" &&
      uniqueOptionTwoValues.length === 0 &&
      uniqueOptionOneValues.length > 0
    ) {
      setVariantImageAxis("option1");
    }
    if (
      variantImageAxis === "option1" &&
      uniqueOptionOneValues.length === 0 &&
      uniqueOptionTwoValues.length > 0
    ) {
      setVariantImageAxis("option2");
    }
  }, [
    setVariantImageAxis,
    uniqueOptionOneValues.length,
    uniqueOptionTwoValues.length,
    variantImageAxis,
  ]);

  // Check if image already exists in the current images array
  const isImageDuplicate = (imageUrl: string, currentImages: ProductFormValues["images"]) => {
    return currentImages.some((img) => img.url === imageUrl);
  };

  // Handle single image selection with duplicate check
  const handleImageSelect = (file: ProductFormValues["images"][number], currentImages: ProductFormValues["images"]) => {
    if (isImageDuplicate(file.url, currentImages)) {
      toast.error("Duplicate Image", { description: "This image has already been added to the product." });
      return currentImages;
    }
    return [...currentImages, file];
  };

  // Handle multiple image selection with duplicate check
  const handleMultipleImageSelect = (files: ProductFormValues["images"], currentImages: ProductFormValues["images"]) => {
    const newFiles = files.filter((file) => {
      if (isImageDuplicate(file.url, currentImages)) {
        return false;
      }
      return true;
    });

    if (newFiles.length < files.length) {
      const duplicateCount = files.length - newFiles.length;
      toast.success("Duplicate Images Skipped", { description: `${duplicateCount} image${duplicateCount > 1 ? "s" : ""} ${duplicateCount > 1 ? "were" : "was"} already added and ${duplicateCount > 1 ? "have" : "has"} been skipped.` });
    }

    return [...currentImages, ...newFiles];
  };

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            aria-expanded={isOpen}
            aria-controls="product-media-content"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                !isOpen && "-rotate-90",
              )}
            />
            <CardTitle className="text-sm">
              Media{imageCount > 0 ? ` (${imageCount})` : ""}
            </CardTitle>
          </button>

          <div className="flex items-center gap-2">
            {hasVariantImageOptions && (
              <div className="flex items-center gap-2">
                <TooltipProvider>
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label="How option image mapping works"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="left"
                      className="max-w-xs bg-popover text-popover-foreground border shadow-md"
                    >
                      <div className="space-y-2 text-xs">
                        <p className="font-semibold">Option image mapping</p>
                        <p>
                          Image badges are stored against {axisLabel}. Dragging
                          images changes gallery order without changing their mapping.
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {variantImageOptions.map((optionValue, idx) => (
                            <span
                              key={optionValue}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-accent rounded text-[10px]"
                            >
                              #{idx + 1} → {optionValue}
                            </span>
                          ))}
                        </div>
                        <p className="text-[10px] opacity-70">
                          Adjust order in Product Options → "Reorder"
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <div className="flex h-8 items-center gap-1.5 rounded-md border px-2">
                  <Switch
                    checked={enableVariantImages}
                    onCheckedChange={setEnableVariantImages}
                    id="variant-images-toggle"
                    className="scale-75"
                  />
                  <Label
                    htmlFor="variant-images-toggle"
                    className="text-[11px] cursor-pointer"
                  >
                    Map images
                  </Label>
                </div>
                {enableVariantImages ? (
                  <Select
                    value={variantImageAxis}
                    onValueChange={(value) => setVariantImageAxis(value as VariantImageAxis)}
                  >
                    <SelectTrigger className="h-8 w-[132px] text-xs">
                      <span className="truncate">{variantImageAxisLabel}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        value="option1"
                        disabled={uniqueOptionOneValues.length === 0}
                      >
                        {normalizedOptionLabels.option1}
                      </SelectItem>
                      <SelectItem
                        value="option2"
                        disabled={uniqueOptionTwoValues.length === 0}
                      >
                        {normalizedOptionLabels.option2}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      {isOpen && (
        <CardContent id="product-media-content" className="px-4 pb-4 pt-0">
          <FormField
            control={form.control}
            name="images"
            render={({ field }) => (
              <FormItem>
                <div className="space-y-2.5">
                  {field.value.length > 0 && (
                    <Suspense
                      fallback={<ImageGalleryFallback count={field.value.length} />}
                    >
                      <DraggableImageGallery
                        images={field.value}
                        variantImageMappingByImageId={variantImageMappingByImageId}
                        enableVariantImages={enableVariantImages}
                        onImagesReorder={(newImages) => field.onChange(newImages)}
                        onImageRemove={(index) => {
                          const newImages = [...field.value];
                          newImages.splice(index, 1);
                          field.onChange(newImages);
                          reconcileMappingsForImages(newImages, false);
                        }}
                        maxVisible={6}
                      />
                    </Suspense>
                  )}
                  <MediaManager
                    selectedFiles={field.value}
                    trigger={
                      field.value.length > 0 ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add media
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                        >
                          <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
                          Choose media
                        </Button>
                      )
                    }
                    onSelect={(file) => {
                      const updatedImages = handleImageSelect(
                        file,
                        field.value,
                      );
                      field.onChange(updatedImages);
                      reconcileMappingsForImages(updatedImages, true);
                    }}
                    onSelectMultiple={(files) => {
                      const updatedImages = handleMultipleImageSelect(
                        files,
                        field.value,
                      );
                      field.onChange(updatedImages);
                      reconcileMappingsForImages(updatedImages, true);
                    }}
                  />
                  {field.value.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Add product images from the media library. The first image is the primary image.
                    </p>
                  ) : null}
                </div>

                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      )}
    </Card>
  );
});

function ImageGalleryFallback({ count }: { count: number }) {
  const placeholders = Array.from({ length: Math.min(count, 6) });

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {placeholders.map((_, index) => (
        <div key={index}>
          <div className="aspect-square animate-pulse rounded-md border bg-muted/60" />
        </div>
      ))}
    </div>
  );
}
