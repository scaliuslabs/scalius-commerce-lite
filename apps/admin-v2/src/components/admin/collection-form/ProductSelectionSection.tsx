import React from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { SearchableSelect } from "../../ui/searchable-select";
import { ChevronDown, ChevronUp, Layers, Package, Trash2 } from "lucide-react";
import type { CollectionFormValues, Category, Product } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";

const MAX_MEMBERSHIP_IDS = 90;

interface ProductSelectionSectionProps {
  form: UseFormReturn<CollectionFormValues>;
  selectedSource: "manual" | "dynamic";
  categories: Category[];
  selectedCategories: Category[];
  selectedProducts: Product[];
  selectedCategoryIds: string[];
  selectedProductIds: string[];
  addCategory: (id: string) => void;
  removeCategory: (id: string) => void;
  addProduct: (product: Product) => void;
  removeProduct: (id: string) => void;
  moveProduct: (id: string, direction: -1 | 1) => void;
}

export const ProductSelectionSection = React.memo(
  function ProductSelectionSection({
    form,
    selectedSource,
    categories,
    selectedCategories,
    selectedProducts,
    selectedCategoryIds,
    selectedProductIds,
    addCategory,
    removeCategory,
    addProduct,
    removeProduct,
    moveProduct,
  }: ProductSelectionSectionProps) {
    return (
      <Card>
        <CardHeader className="px-4 pb-3 pt-4">
          <CardTitle className="text-base">Collection content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4">
          <FormField
            control={form.control}
            name="config.source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Content source</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="manual">Manual selection</SelectItem>
                    <SelectItem value="dynamic">Dynamic by category</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription className="text-xs">
                  {selectedSource === "manual"
                    ? "Choose products and arrange their storefront order."
                    : "New eligible products from the selected categories appear automatically."}
                </FormDescription>
              </FormItem>
            )}
          />

          {selectedSource === "dynamic" ? (
            <FormField
              control={form.control}
              name="config.categoryIds"
              render={() => (
                <FormItem className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <FormLabel className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-muted-foreground" /> Categories
                    </FormLabel>
                    <span className="text-xs tabular-nums text-muted-foreground">{selectedCategoryIds.length}/{MAX_MEMBERSHIP_IDS}</span>
                  </div>
                  <SearchableSelect
                    onValueChange={addCategory}
                    options={categories
                      .filter((category) => !selectedCategoryIds.includes(category.id))
                      .map((category) => ({ value: category.id, label: category.name }))}
                    placeholder="Add a category"
                    searchPlaceholder="Search categories..."
                    emptyMessage="No more categories available."
                    ariaLabel="Add a category to this collection"
                    disabled={selectedCategoryIds.length >= MAX_MEMBERSHIP_IDS}
                    triggerClassName="w-full"
                  />
                  {selectedCategories.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedCategories.map((category) => (
                        <Badge key={category.id} variant="secondary" className="gap-1 pr-1">
                          <span className="max-w-[220px] truncate">{category.name}</span>
                          <Button type="button" variant="ghost" size="icon" className="h-5 w-5" onClick={() => removeCategory(category.id)} aria-label={`Remove ${category.name}`}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">Select a category to define this collection.</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : (
            <FormField
              control={form.control}
              name="config.productIds"
              render={() => (
                <FormItem className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <FormLabel className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-muted-foreground" /> Products
                    </FormLabel>
                    <span className="text-xs tabular-nums text-muted-foreground">{selectedProductIds.length}/{MAX_MEMBERSHIP_IDS}</span>
                  </div>
                  <ProductPickerPopover triggerLabel="Search products to add" excludeProductIds={selectedProductIds} onSelectProduct={addProduct} buttonClassName="w-full justify-between font-normal" disabled={selectedProductIds.length >= MAX_MEMBERSHIP_IDS} />
                  {selectedProducts.length > 0 ? (
                    <ol className="divide-y rounded-md border" aria-label="Manual product order">
                      {selectedProducts.map((product, index) => (
                        <li key={product.id} className="flex min-h-10 items-center gap-2 px-2 py-1.5">
                          <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-sm">{product.name}</span>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => moveProduct(product.id, -1)} aria-label={`Move ${product.name} up`}><ChevronUp className="h-3.5 w-3.5" /></Button>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={index === selectedProducts.length - 1} onClick={() => moveProduct(product.id, 1)} aria-label={`Move ${product.name} down`}><ChevronDown className="h-3.5 w-3.5" /></Button>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => removeProduct(product.id)} aria-label={`Remove ${product.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">Add products to define this collection. Their order is saved.</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </CardContent>
      </Card>
    );
  },
);
