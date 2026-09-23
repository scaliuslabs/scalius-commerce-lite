import React from "react";
import type { UseFormReturn } from "react-hook-form";
import { ChevronDown, ChevronUp, ImageIcon, X } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { FormControl, FormField, FormItem, FormMessage } from "~/components/ui/form";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { collectionFormMessages } from "~/i18n/collection-form";
import { MAX_MEMBERSHIP_IDS } from "./types";
import type { Category, CollectionFormInput, CollectionFormValues, Product } from "./types";
import { ProductPickerDialog } from "./ProductPickerDialog";

interface ProductSelectionSectionProps {
  form: UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;
  selectedSource: "manual" | "dynamic";
  categories: Category[];
  selectedProducts: Product[];
  selectedCategoryIds: string[];
  selectedProductIds: string[];
  addCategory: (id: string) => void;
  removeCategory: (id: string) => void;
  addProducts: (products: Product[]) => void;
  removeProduct: (id: string) => void;
  moveProduct: (id: string, direction: -1 | 1) => void;
}

function Thumbnail({ image }: { image?: string | null }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {image ? (
        <img src={mediaImageUrl(image, 160)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}

/** Which products are in the collection: picked by hand, or every product in some categories. */
export const ProductSelectionSection = React.memo(function ProductSelectionSection({
  form,
  selectedSource,
  categories,
  selectedProducts,
  selectedCategoryIds,
  selectedProductIds,
  addCategory,
  removeCategory,
  addProducts,
  removeProduct,
  moveProduct,
}: ProductSelectionSectionProps) {
  const t = useMessages(collectionFormMessages);
  const tc = useMessages(catalogMessages);
  const selectedCategories = categories.filter((category) => selectedCategoryIds.includes(category.id));
  const hasUnpublished = selectedCategories.some((category) => category.status !== "published");
  const sources = [
    { value: "manual", label: t("pickProducts"), help: t("pickProductsHelp") },
    { value: "dynamic", label: t("automatic"), help: t("automaticHelp") },
  ] as const;
  const count = selectedSource === "manual" ? selectedProductIds.length : selectedCategoryIds.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("products")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          control={form.control}
          name="config.source"
          rules={{ deps: ["config.productIds", "config.categoryIds"] }}
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <RadioGroup value={field.value} onValueChange={field.onChange} aria-label={t("products")}>
                  {sources.map((source) => (
                    <label key={source.value} className="flex items-start gap-3">
                      <span className="flex h-lh items-center">
                        <RadioGroupItem value={source.value} />
                      </span>
                      <span>
                        {source.label}
                        <span className="block text-muted-foreground">{source.help}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </FormControl>
            </FormItem>
          )}
        />

        <div className="space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-body tabular-nums text-muted-foreground">
              {t("countOfMax", { count, max: MAX_MEMBERSHIP_IDS })}
            </span>
            {selectedSource === "manual" ? (
              <ProductPickerDialog
                selectedProductIds={selectedProductIds}
                onAddProducts={addProducts}
                maxProducts={MAX_MEMBERSHIP_IDS}
              />
            ) : (
              <div className="w-full sm:w-64">
                <SearchableSelect
                  onValueChange={addCategory}
                  options={categories
                    .filter((category) => category.status === "published" && !selectedCategoryIds.includes(category.id))
                    .map((category) => ({ value: category.id, label: category.name }))}
                  placeholder={t("addCategory")}
                  searchPlaceholder={t("searchCategories")}
                  emptyMessage={t("noMoreCategories")}
                  ariaLabel={t("addCategory")}
                  disabled={selectedCategoryIds.length >= MAX_MEMBERSHIP_IDS}
                />
              </div>
            )}
          </div>

          {selectedSource === "manual" ? (
            <FormField
              control={form.control}
              name="config.productIds"
              render={() => (
                <FormItem>
                  {selectedProducts.length > 0 ? (
                    <ol className="divide-y rounded-lg border" aria-label={t("products")}>
                      {selectedProducts.map((product, index) => (
                        <li key={product.id} className="flex items-center gap-3 px-3 py-2">
                          <Thumbnail image={product.primaryImage} />
                          <span className="min-w-0 flex-1 truncate">{product.name}</span>
                          {product.isActive === false ? <Badge variant="attention">{t("draft")}</Badge> : null}
                          <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => moveProduct(product.id, -1)} aria-label={t("moveUp", { name: product.name })}>
                            <ChevronUp />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-sm" disabled={index === selectedProducts.length - 1} onClick={() => moveProduct(product.id, 1)} aria-label={t("moveDown", { name: product.name })}>
                            <ChevronDown />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeProduct(product.id)} aria-label={t("remove", { name: product.name })}>
                            <X />
                          </Button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground">{t("noProducts")}</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : (
            <FormField
              control={form.control}
              name="config.categoryIds"
              render={() => (
                <FormItem>
                  {selectedCategories.length > 0 ? (
                    <ul className="divide-y rounded-lg border" aria-label={tc("categories")}>
                      {selectedCategories.map((category) => (
                        <li key={category.id} className="flex items-center gap-3 px-3 py-2">
                          <span className="min-w-0 flex-1 truncate">{category.name}</span>
                          {category.status === "draft" ? <Badge variant="attention">{tc("draft")}</Badge> : null}
                          {category.status === "internal" ? <Badge variant="secondary">{tc("hidden")}</Badge> : null}
                          <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeCategory(category.id)} aria-label={t("remove", { name: category.name })}>
                            <X />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground">{t("noCategories")}</p>
                  )}
                  {hasUnpublished ? <p className="text-warning">{t("publishCategories")}</p> : null}
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
});
