import React from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MediaManager } from "../../media-manager";
import { ImageIcon, Package, Tags, X, Check, Loader2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useAiContext } from "./useAiContext";
import { getEffectiveImageLimit } from "./ai-context-limits";
import { toast } from "sonner";
import type { MediaFile } from "./types";

interface AiContextManagerProps {
  context: ReturnType<typeof useAiContext>;
  selectedModel?: string;
  supportsVision?: boolean;
  maxImages?: number;
  variant?: "default" | "compact";
}

export const AiContextManager: React.FC<AiContextManagerProps> = ({
  context,
  selectedModel,
  supportsVision = false,
  maxImages,
  variant = "default",
}) => {
  const [isImagePopoverOpen, setIsImagePopoverOpen] = React.useState(false);
  const {
    selectedImages,
    selectedProducts,
    selectedCategories,
    allCategoriesSelected,
    handleImageSelect,
    handleMultiImageSelect,
    removeImage,
    handleProductSelect,
    removeProduct,
    handleCategorySelect,
    removeCategory,
    handleToggleAllCategories,
    allCategoriesList,
    isProductPopoverOpen,
    setIsProductPopoverOpen,
    productSearchQuery,
    setProductSearchQuery,
    isFetchingProducts,
    productsToShow,
    hasMoreProducts,
    loadMoreProducts,
    categorySearchQuery,
    setCategorySearchQuery,
    isCategoryPopoverOpen,
    setIsCategoryPopoverOpen,
    hasMoreCategories,
    loadMoreCategories,
    isFetchingCategories,
    maxProducts,
    maxCategories,
  } = context;

  const maxImagesForModel = getEffectiveImageLimit(selectedModel, maxImages);
  const imageOverage = Math.max(0, selectedImages.length - maxImagesForModel);

  const addOneImage = (file: MediaFile) => {
    if (selectedImages.some((img) => img.url === file.url)) return;
    if (selectedImages.length >= maxImagesForModel) {
      toast.error(`This model can use up to ${maxImagesForModel} images.`);
      return;
    }
    handleImageSelect(file);
  };

  const addManyImages = (files: MediaFile[]) => {
    const uniqueNewFiles = files.filter(
      (file) => !selectedImages.some((img) => img.url === file.url),
    );
    const availableSlots = Math.max(0, maxImagesForModel - selectedImages.length);
    const filesToAdd = uniqueNewFiles.slice(0, availableSlots);
    if (filesToAdd.length > 0) handleMultiImageSelect(filesToAdd);
    if (uniqueNewFiles.length > filesToAdd.length) {
      toast.error(`Added ${filesToAdd.length}; skipped ${uniqueNewFiles.length - filesToAdd.length} over the ${maxImagesForModel}-image limit.`);
    }
  };

  const formatPrice = (value?: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
      : null;

  const gridClass =
    variant === "compact"
      ? "grid grid-cols-1 gap-2"
      : "grid grid-cols-1 md:grid-cols-3 gap-3";

  const popoverWidth = "w-[min(max(var(--radix-popover-trigger-width),22rem),calc(100vw-2rem))]";
  const popoverZIndex = variant === "compact" ? "z-[101]" : "";
  const commandListClass =
    "max-h-[clamp(9rem,calc(var(--radix-popover-content-available-height)-2.75rem),20rem)]";
  const categoryCommandListClass =
    "max-h-[clamp(8rem,calc(var(--radix-popover-content-available-height)-7rem),18rem)]";

  return (
    <>
      <div className={gridClass}>
        <Popover open={isImagePopoverOpen} onOpenChange={setIsImagePopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start gap-2 h-9"
            >
              <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>Images ({selectedImages.length}/{maxImagesForModel})</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(popoverWidth, popoverZIndex, "overflow-hidden p-0")}
            align="start"
            sideOffset={5}
            collisionPadding={16}
          >
            <div className="p-3 border-b">
              <MediaManager
                onSelect={addOneImage}
                onSelectMultiple={addManyImages}
                selectedFiles={selectedImages}
                triggerLabel="Select Images"
                dialogClassName={variant === "compact" ? "z-[102]" : undefined}
              />
              <p className="text-xs text-muted-foreground mt-2">
                {supportsVision
                  ? `Max ${maxImagesForModel} images. Model supports vision - images will be analyzed.`
                  : `Max ${maxImagesForModel} images. Image metadata (size, name, aspect ratio) will be included in prompt.`}
              </p>
              {imageOverage > 0 && (
                <p className="mt-2 text-xs font-medium text-amber-600">
                  This model will use the first {maxImagesForModel} images and skip {imageOverage}.
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>

        <Popover
          open={isProductPopoverOpen}
          onOpenChange={setIsProductPopoverOpen}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start gap-2 h-9"
            >
              <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>Products ({selectedProducts.length}/{maxProducts})</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(popoverWidth, popoverZIndex, "overflow-hidden p-0")}
            align="start"
            sideOffset={5}
            collisionPadding={16}
          >
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search for products..."
                value={productSearchQuery}
                onValueChange={setProductSearchQuery}
              />
              <CommandList className={commandListClass}>
                <CommandEmpty>
                  {isFetchingProducts ? "Loading..." : "No products found."}
                </CommandEmpty>
                <CommandGroup>
                  {productsToShow.map((product) => {
                    const isSelected = selectedProducts.some((p) => p.id === product.id);
                    const price = formatPrice(product.price);
                    return (
                    <CommandItem
                      key={product.id}
                      onSelect={() => handleProductSelect(product)}
                      className="gap-3"
                    >
                      {product.primaryImage ? (
                        <img
                          src={product.primaryImage}
                          alt=""
                          className="h-10 w-10 rounded-md object-cover border"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-md border bg-muted">
                          <Package className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{product.name}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          {price && <span>{price}</span>}
                          {product.category?.name && <span>{product.category.name}</span>}
                          {product.sku && <span>SKU {product.sku}</span>}
                          {typeof product.variantCount === "number" && product.variantCount > 0 && (
                            <span>{product.variantCount} variants</span>
                          )}
                          {product.isActive === false && <span className="text-amber-600">Inactive</span>}
                        </div>
                      </div>
                    </CommandItem>
                    );
                  })}
                </CommandGroup>
                {hasMoreProducts && (
                  <CommandItem
                    onSelect={() => loadMoreProducts()}
                    className="justify-center text-center text-sm text-primary cursor-pointer aria-selected:bg-transparent"
                  >
                    {isFetchingProducts ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Load More"
                    )}
                  </CommandItem>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Popover
          open={isCategoryPopoverOpen}
          onOpenChange={setIsCategoryPopoverOpen}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start gap-2 h-9"
            >
              <Tags className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                Categories (
                {allCategoriesSelected ? `All ${maxCategories}` : `${selectedCategories.length}/${maxCategories}`})
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(popoverWidth, popoverZIndex, "overflow-hidden p-0")}
            align="start"
            sideOffset={5}
            collisionPadding={16}
          >
            <div className="p-3 border-b">
              <div className="flex items-center space-x-2">
                <Switch
                  id="all-categories-modal"
                  checked={allCategoriesSelected}
                  onCheckedChange={handleToggleAllCategories}
                />
                <Label htmlFor="all-categories-modal">
                  Include All Categories
                </Label>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Uses up to {maxCategories} categories alphabetically.
              </p>
            </div>
            <Command
              className={cn(
                allCategoriesSelected && "opacity-50 pointer-events-none",
              )}
              shouldFilter={false}
            >
              <CommandInput
                placeholder="Search categories..."
                value={categorySearchQuery}
                onValueChange={setCategorySearchQuery}
              />
              <CommandList className={categoryCommandListClass}>
                <CommandEmpty>
                  {isFetchingCategories ? "Loading..." : "No categories found."}
                </CommandEmpty>
                <CommandGroup>
                  {allCategoriesList.map((category) => (
                    <CommandItem
                      key={category.id}
                      onSelect={() => handleCategorySelect(category)}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          selectedCategories.some((c) => c.id === category.id)
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                      {category.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {hasMoreCategories && (
                  <CommandItem
                    onSelect={() => loadMoreCategories()}
                    className="justify-center text-center text-sm text-primary cursor-pointer aria-selected:bg-transparent"
                  >
                    {isFetchingCategories ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Load More"
                    )}
                  </CommandItem>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {(selectedImages.length > 0 ||
        selectedProducts.length > 0 ||
        selectedCategories.length > 0 ||
        allCategoriesSelected) && (
        <div className="p-3 border rounded-lg bg-background/50 space-y-2">
          <h5 className="text-sm font-medium text-muted-foreground">
            Selected Context:
          </h5>
          {imageOverage > 0 && (
            <p className="text-xs font-medium text-amber-600">
              The selected model accepts {maxImagesForModel} images. Generation keeps your full selection saved here but only sends the first {maxImagesForModel}.
            </p>
          )}
          <div className="flex flex-wrap gap-2 items-start">
            {selectedImages.map((f) => (
              <Badge
                key={f.id}
                variant="secondary"
                className="gap-1.5 pr-1 max-w-full h-7"
              >
                <ImageIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{f.filename}</span>
                <button
                  type="button"
                  aria-label={`Remove image ${f.filename}`}
                  onClick={() => removeImage(f.url)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5 shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {selectedProducts.map((p) => (
              <Badge
                key={p.id}
                variant="secondary"
                className="gap-1.5 pr-1 max-w-full h-7"
              >
                <Package className="h-3 w-3 shrink-0" />
                <span className="truncate">{p.name}</span>
                <button
                  type="button"
                  aria-label={`Remove product ${p.name}`}
                  onClick={() => removeProduct(p.id)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5 shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {allCategoriesSelected && (
              <Badge variant="secondary" className="h-7">
                <Tags className="h-3 w-3 mr-1.5" /> All Categories
              </Badge>
            )}
            {selectedCategories.map((c) => (
              <Badge
                key={c.id}
                variant="secondary"
                className="gap-1.5 pr-1 max-w-full h-7"
              >
                <Tags className="h-3 w-3 shrink-0" />
                <span className="truncate">{c.name}</span>
                <button
                  type="button"
                  aria-label={`Remove category ${c.name}`}
                  onClick={() => removeCategory(c.id)}
                  className="rounded-full hover:bg-muted-foreground/20 p-0.5 shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </>
  );
};
