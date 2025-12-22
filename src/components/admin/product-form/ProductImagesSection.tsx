// src/components/admin/product-form/ProductImagesSection.tsx
import React from "react";
import type { UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info, ChevronDown} from "lucide-react";
import { MediaManager } from "../MediaManager";
import { DraggableImageGallery } from "../DraggableImageGallery";
import { cn } from "@/lib/utils";
import type { ProductFormValues } from "./types";
import { useToast } from "@/hooks/use-toast";

interface ProductImagesSectionProps {
  form: UseFormReturn<ProductFormValues>;
  enableVariantImages: boolean;
  setEnableVariantImages: (enabled: boolean) => void;
  uniqueColorOptions: string[];
}

export function ProductImagesSection({
  form,
  enableVariantImages,
  setEnableVariantImages,
  uniqueColorOptions,
}: ProductImagesSectionProps) {
  const [isOpen, setIsOpen] = React.useState(true);
  const { toast } = useToast();

  // Check if image already exists in the current images array
  const isImageDuplicate = (imageUrl: string, currentImages: any[]) => {
    return currentImages.some((img) => img.url === imageUrl);
  };

  // Handle single image selection with duplicate check
  const handleImageSelect = (file: any, currentImages: any[]) => {
    if (isImageDuplicate(file.url, currentImages)) {
      toast({
        title: "Duplicate Image",
        description: "This image has already been added to the product.",
        variant: "destructive",
      });
      return currentImages;
    }
    return [...currentImages, file];
  };

  // Handle multiple image selection with duplicate check
  const handleMultipleImageSelect = (files: any[], currentImages: any[]) => {
    const newFiles = files.filter((file) => {
      if (isImageDuplicate(file.url, currentImages)) {
        return false;
      }
      return true;
    });

    if (newFiles.length < files.length) {
      const duplicateCount = files.length - newFiles.length;
      toast({
        title: "Duplicate Images Skipped",
        description: `${duplicateCount} image${duplicateCount > 1 ? "s" : ""} ${duplicateCount > 1 ? "were" : "was"} already added and ${duplicateCount > 1 ? "have" : "has"} been skipped.`,
        variant: "default",
      });
    }

    return [...currentImages, ...newFiles];
  };

  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                !isOpen && "-rotate-90",
              )}
            />
            <CardTitle className="text-sm">
              Media{" "}
              {form.watch("images")?.length > 0 &&
                `(${form.watch("images").length})`}
            </CardTitle>
          </button>

          <div className="flex items-center gap-2">
            {uniqueColorOptions.length > 0 && (
              <div className="flex items-center gap-2">
                <TooltipProvider>
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="left"
                      className="max-w-xs bg-popover text-popover-foreground border shadow-md"
                    >
                      <div className="space-y-2 text-xs">
                        <p className="font-semibold">Color-Image Mapping</p>
                        <p>When enabled, images map to colors in order:</p>
                        <div className="flex flex-wrap gap-1">
                          {uniqueColorOptions.map((color, idx) => (
                            <span
                              key={color}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-accent rounded text-[10px]"
                            >
                              #{idx + 1} → {color}
                            </span>
                          ))}
                        </div>
                        <p className="text-[10px] opacity-70">
                          Adjust order in Variants → "Sort Options"
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <div className="flex items-center gap-1.5 rounded border px-2 py-1">
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
                    Map to Colors
                  </Label>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      {isOpen && (
        <CardContent className="space-y-2 px-3 pb-3">
          <FormField
            control={form.control}
            name="images"
            render={({ field }) => (
              <FormItem>
                <div className="space-y-3">
                  {field.value.length > 0 && (
                    <DraggableImageGallery
                      images={field.value}
                      colorOptions={uniqueColorOptions}
                      enableVariantImages={enableVariantImages}
                      onImagesReorder={(newImages) => field.onChange(newImages)}
                      onImageRemove={(index) => {
                        const newImages = [...field.value];
                        newImages.splice(index, 1);
                        field.onChange(newImages);
                      }}
                      maxVisible={6}
                    />
                  )}
                  <MediaManager
                    selectedFiles={field.value}
                    onSelect={(file) => {
                      const updatedImages = handleImageSelect(
                        file,
                        field.value,
                      );
                      field.onChange(updatedImages);
                    }}
                    onSelectMultiple={(files) => {
                      const updatedImages = handleMultipleImageSelect(
                        files,
                        field.value,
                      );
                      field.onChange(updatedImages);
                    }}
                  />
                </div>

                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      )}
    </Card>
  );
}
