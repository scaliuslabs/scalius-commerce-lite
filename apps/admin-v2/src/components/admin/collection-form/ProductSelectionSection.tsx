import React from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
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
import { ChevronDown, ChevronUp, ImageIcon, Layers, Package, Trash2 } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";
import type {
  CollectionFormInput,
  CollectionFormValues,
  Category,
  Product,
} from "./types";
import { ProductPickerDialog } from "./ProductPickerDialog";

const MAX_MEMBERSHIP_IDS = 90;

interface ProductSelectionSectionProps {
  form: UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;
  selectedSource: "manual" | "dynamic";
  categories: Category[];
  selectedCategories: Category[];
  selectedProducts: Product[];
  selectedCategoryIds: string[];
  selectedProductIds: string[];
  addCategory: (id: string) => void;
  removeCategory: (id: string) => void;
  addProducts: (products: Product[]) => void;
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
    addProducts,
    removeProduct,
    moveProduct,
  }: ProductSelectionSectionProps) {
    const unpublishedSelectedCategories = selectedSource === "dynamic"
      ? selectedCategories.filter((category) => category.status !== "published")
      : [];

    return (
      <Card>
        <CardHeader className="px-4 pb-3 pt-4">
          <CardTitle className="text-base">Products</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-4 pb-4">
          <FormField
            control={form.control}
            name="config.source"
            rules={{ deps: ["config.productIds", "config.categoryIds"] }}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Product selection</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="min-h-11 md:h-9 md:min-h-9">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="manual">Choose products</SelectItem>
                    <SelectItem value="dynamic">Use categories</SelectItem>
                  </SelectContent>
                </Select>
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
                      .filter((category) =>
                        category.status === "published" &&
                        !selectedCategoryIds.includes(category.id))
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
                          {category.status !== "published" ? (
                            <span className="text-[10px] uppercase text-amber-700 dark:text-amber-300">
                              {category.status}
                            </span>
                          ) : null}
                          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 sm:h-5 sm:w-5" onClick={() => removeCategory(category.id)} aria-label={`Remove ${category.name}`}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No categories selected.</p>
                  )}
                  {unpublishedSelectedCategories.length > 0 ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Publish every selected category before activating this collection, or keep the collection inactive.
                    </p>
                  ) : null}
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
                  <ProductPickerDialog
                    selectedProductIds={selectedProductIds}
                    onAddProducts={addProducts}
                    maxProducts={MAX_MEMBERSHIP_IDS}
                    disabled={selectedProductIds.length >= MAX_MEMBERSHIP_IDS}
                  />
                  {selectedProducts.length > 0 ? (
                    <ol className="divide-y rounded-md border" aria-label="Manual product order">
                      {selectedProducts.map((product, index) => (
                        <li key={product.id} className="flex min-h-14 items-center gap-2 px-2 py-1.5 sm:min-h-10">
                          <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted sm:h-8 sm:w-8">
                            {product.primaryImage ? (
                              <img
                                src={getOptimizedImageUrl(product.primaryImage, ADMIN_IMAGE_PRESETS.productMicro)}
                                alt=""
                                className="h-full w-full object-contain object-center"
                                loading="lazy"
                                decoding="async"
                              />
                            ) : (
                              <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">{product.name}</span>
                          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 sm:h-7 sm:w-7" disabled={index === 0} onClick={() => moveProduct(product.id, -1)} aria-label={`Move ${product.name} up`}><ChevronUp className="h-3.5 w-3.5" /></Button>
                          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 sm:h-7 sm:w-7" disabled={index === selectedProducts.length - 1} onClick={() => moveProduct(product.id, 1)} aria-label={`Move ${product.name} down`}><ChevronDown className="h-3.5 w-3.5" /></Button>
                          <Button type="button" variant="ghost" size="icon" className="h-11 w-11 text-muted-foreground hover:text-destructive sm:h-7 sm:w-7" onClick={() => removeProduct(product.id)} aria-label={`Remove ${product.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No products selected.</p>
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
