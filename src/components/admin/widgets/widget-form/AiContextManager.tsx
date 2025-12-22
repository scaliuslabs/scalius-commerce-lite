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
import { MediaManager } from "../../MediaManager";
import { ImageIcon, Package, Tags, X, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAiContext } from "./useAiContext";
import { getMaxImages } from "@/lib/ai-config";

interface AiContextManagerProps {
  context: ReturnType<typeof useAiContext>;
  selectedModel?: string;
  supportsVision?: boolean;
  variant?: "default" | "compact";
}

export const AiContextManager: React.FC<AiContextManagerProps> = ({
  context,
  selectedModel,
  supportsVision = false,
  variant = "default",
}) => {
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
    debouncedProductSearch,
    hasMoreProducts,
    fetchProductsForSelector,
    productPage,
  } = context;

  const maxImagesForModel = selectedModel ? getMaxImages(selectedModel) : 10;

  const gridClass =
    variant === "compact"
      ? "grid grid-cols-1 gap-2"
      : "grid grid-cols-1 md:grid-cols-3 gap-3";

  const popoverWidth = variant === "compact" ? "w-[320px]" : "w-[300px]";
  const popoverZIndex = variant === "compact" ? "z-[101]" : "";

  return (
    <>
      <div className={gridClass}>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-start gap-2 h-9"
            >
              <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>Images ({selectedImages.length})</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(popoverWidth, popoverZIndex, "p-0")}
            align="start"
            sideOffset={5}
          >
            <div className="p-3 border-b">
              <MediaManager
                onSelect={handleImageSelect}
                onSelectMultiple={handleMultiImageSelect}
                selectedFiles={selectedImages}
                triggerLabel="Select Images"
                dialogClassName={variant === "compact" ? "z-[102]" : undefined}
              />
              <p className="text-xs text-muted-foreground mt-2">
                {supportsVision
                  ? `Max ${maxImagesForModel} images. Model supports vision - images will be analyzed.`
                  : `Max ${maxImagesForModel} images. Image metadata (size, name, aspect ratio) will be included in prompt.`}
              </p>
            </div>
          </PopoverContent>
        </Popover>

        <Popover
          open={isProductPopoverOpen}
          onOpenChange={setIsProductPopoverOpen}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-start gap-2 h-9"
            >
              <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>Products ({selectedProducts.length})</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(popoverWidth, popoverZIndex, "p-0")}
            align="start"
            sideOffset={5}
          >
            <Command>
              <CommandInput
                placeholder="Search for products..."
                value={productSearchQuery}
                onValueChange={setProductSearchQuery}
              />
              <CommandList>
                <CommandEmpty>
                  {isFetchingProducts ? "Loading..." : "No products found."}
                </CommandEmpty>
                <CommandGroup>
                  {productsToShow.map((product) => (
                    <CommandItem
                      key={product.id}
                      onSelect={() => handleProductSelect(product)}
                    >
                      {product.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {!debouncedProductSearch.trim() && hasMoreProducts && (
                  <CommandItem
                    onSelect={() => fetchProductsForSelector(productPage + 1)}
                    className="justify-center text-center text-sm text-primary cursor-pointer aria-selected:bg-transparent"
                  >
                    {isFetchingProducts && productPage > 1 ? (
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

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-start gap-2 h-9"
            >
              <Tags className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                Categories (
                {allCategoriesSelected ? "All" : selectedCategories.length})
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(popoverWidth, popoverZIndex, "p-0")}
            align="start"
            sideOffset={5}
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
            </div>
            <Command
              className={cn(
                allCategoriesSelected && "opacity-50 pointer-events-none",
              )}
            >
              <CommandInput placeholder="Search categories..." />
              <CommandList>
                <CommandEmpty>No categories found.</CommandEmpty>
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
