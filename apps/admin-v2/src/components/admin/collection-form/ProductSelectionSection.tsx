import React from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormDescription,
  FormLabel,
} from "../../ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Button } from "../../ui/button";
import { Alert, AlertDescription } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Trash2, Layers, Package, Info } from "lucide-react";
import type { CollectionFormValues, Category, Product } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";

interface ProductSelectionSectionProps {
  form: UseFormReturn<CollectionFormValues>;
  categories: Category[];
  selectedCategories: Category[];
  selectedProducts: Product[];
  selectedCategoryIds: string[];
  selectedProductIds: string[];
  addCategory: (id: string) => void;
  removeCategory: (id: string) => void;
  addProduct: (product: Product) => void;
  removeProduct: (id: string) => void;
}

export const ProductSelectionSection = React.memo(
  function ProductSelectionSection({
    categories,
    selectedCategories,
    selectedProducts,
    selectedCategoryIds,
    selectedProductIds,
    addCategory,
    removeCategory,
    addProduct,
    removeProduct,
  }: ProductSelectionSectionProps) {
    const hasSpecificProducts = selectedProductIds.length > 0;
    const hasCategoriesOnly =
      selectedCategoryIds.length > 0 && !hasSpecificProducts;

    return (
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-base">Product Selection</CardTitle>
          <CardDescription className="text-xs">
            Choose categories or specific products to include
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* Category Selection */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <FormLabel>Categories</FormLabel>
            </div>
            <div className="flex gap-2">
              <Select
                onValueChange={(value) => {
                  if (value) addCategory(value);
                }}
                value=""
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select categories to include..." />
                </SelectTrigger>
                <SelectContent className="rounded-xl bg-background max-h-[300px]">
                  {categories
                    .filter((cat) => !selectedCategoryIds.includes(cat.id))
                    .map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {selectedCategories.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedCategories.map((category) => (
                  <Badge
                    key={category.id}
                    variant="secondary"
                    className="flex items-center gap-1 pr-1.5"
                  >
                    <span className="truncate max-w-[180px]">
                      {category.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive/20"
                      onClick={() => removeCategory(category.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Informational text about how categories/products interact */}
          {hasCategoriesOnly && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                All active products from selected categories will be shown on
                the storefront (up to max products limit).
              </AlertDescription>
            </Alert>
          )}

          {hasSpecificProducts && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                These specific products will be shown in the collection.
                {selectedCategoryIds.length > 0
                  ? " Category selection is used to filter the product search below only."
                  : ""}
              </AlertDescription>
            </Alert>
          )}

          {/* Product Selection */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              <FormLabel>Specific Products (Optional)</FormLabel>
            </div>
            <ProductPickerPopover
              triggerLabel="Search products to add..."
              selectedCategoryIds={selectedCategoryIds}
              excludeProductIds={selectedProductIds}
              onSelectProduct={addProduct}
              buttonClassName="w-full justify-between font-normal"
            />
            {selectedProducts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedProducts.map((product) => (
                  <Badge
                    key={product.id}
                    variant="outline"
                    className="flex items-center gap-1 pr-1.5"
                  >
                    <span className="truncate max-w-[180px]">
                      {product.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive/20"
                      onClick={() => removeProduct(product.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
            <FormDescription>
              Add specific products that will always be included regardless of
              category selection
            </FormDescription>
          </div>
        </CardContent>
      </Card>
    );
  },
);
