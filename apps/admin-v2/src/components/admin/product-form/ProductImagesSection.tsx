import React, { lazy, memo, Suspense } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ChevronDown, ImagePlus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { MediaManager } from "../media-manager";
import { cn } from "@scalius/shared/utils";
import type { ProductFormValues } from "./types";

const DraggableImageGallery = lazy(() =>
  import("../DraggableImageGallery").then((module) => ({
    default: module.DraggableImageGallery,
  })),
);

export const ProductImagesSection = memo(function ProductImagesSection({
  form,
}: {
  form: UseFormReturn<ProductFormValues>;
}) {
  const [isOpen, setIsOpen] = React.useState(true);
  const imageCount = form.watch("images")?.length ?? 0;

  const addImages = React.useCallback((
    current: ProductFormValues["images"],
    incoming: ProductFormValues["images"],
  ) => {
    const existingUrls = new Set(current.map((image) => image.url));
    const unique = incoming.filter((image) => !existingUrls.has(image.url));
    const skipped = incoming.length - unique.length;
    if (skipped > 0) {
      toast.info(`${skipped} duplicate ${skipped === 1 ? "image was" : "images were"} skipped.`);
    }
    return [...current, ...unique];
  }, []);

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={isOpen}
          aria-controls="product-media-content"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", !isOpen && "-rotate-90")} />
          <CardTitle className="text-sm">Media{imageCount ? ` (${imageCount})` : ""}</CardTitle>
          <span className="ml-auto text-[11px] text-muted-foreground">
            First image is the storefront thumbnail
          </span>
        </button>
      </CardHeader>
      {isOpen ? (
        <CardContent id="product-media-content" className="px-4 pb-4 pt-0">
          <FormField
            control={form.control}
            name="images"
            render={({ field }) => (
              <FormItem>
                <div className="space-y-2.5">
                  {field.value.length > 0 ? (
                    <Suspense fallback={<ImageGalleryFallback count={field.value.length} />}>
                      <DraggableImageGallery
                        images={field.value}
                        enableVariantImages={false}
                        onImagesReorder={field.onChange}
                        onImageRemove={(index) => {
                          const next = [...field.value];
                          next.splice(index, 1);
                          field.onChange(next);
                        }}
                        maxVisible={6}
                      />
                    </Suspense>
                  ) : null}
                  <MediaManager
                    capability="image"
                    selectedFiles={field.value}
                    trigger={(
                      <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs">
                        {field.value.length ? <Plus className="mr-1.5 h-3.5 w-3.5" /> : <ImagePlus className="mr-1.5 h-3.5 w-3.5" />}
                        {field.value.length ? "Add media" : "Choose media"}
                      </Button>
                    )}
                    onSelect={(file) => field.onChange(addImages(field.value, [file]))}
                    onSelectMultiple={(files) => field.onChange(addImages(field.value, files))}
                  />
                  {field.value.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Add product media here. Each SKU can then choose one of these images directly in the matrix.
                    </p>
                  ) : null}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      ) : null}
    </Card>
  );
});

function ImageGalleryFallback({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: Math.min(count, 6) }, (_, index) => (
        <div key={index} className="aspect-square animate-pulse rounded-md border bg-muted/60" />
      ))}
    </div>
  );
}
