import React from "react";
import type { UseFormReturn } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { FormControl, FormField, FormItem, FormMessage } from "~/components/ui/form";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { collectionFormMessages } from "~/i18n/collection-form";
import { resourceMessages } from "~/i18n/resource";
import { MAX_MEMBERSHIP_IDS } from "./types";
import type { Category, CollectionFormInput, CollectionFormValues, Product } from "./types";
import {
  ProductOptionMeta,
  ProductOptionsStatus,
  ProductPickerDialog,
  ProductThumbnail,
  useProductOptions,
} from "./ProductPickerDialog";

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

/** The products an automatic collection holds right now (published categories only). */
function RulePreview({ categoryIds }: { categoryIds: string[] }) {
  const t = useMessages(collectionFormMessages);
  const tr = useMessages(resourceMessages);
  const options = useProductOptions({ open: categoryIds.length > 0, categoryIds, limit: 10 });
  const { query, products, total } = options;
  if (categoryIds.length === 0) return null;
  return (
    <section className="space-y-2 border-t pt-4" aria-label={t("matchingProducts")}>
      <h3 className="flex items-baseline justify-between gap-2 text-heading-sm">
        {t("matchingProducts")}
        {options.isLoading || query.isError ? null : (
          <span className="text-body tabular-nums text-muted-foreground">
            {total === 1 ? t("productOne") : t("productCount", { count: total })}
          </span>
        )}
      </h3>
      <div className="rounded-lg border">
        {products.length === 0 && !options.isLoading && !query.isError ? (
          <p className="px-3 py-4 text-center text-muted-foreground">{t("noMatchingProducts")}</p>
        ) : (
          <ProductOptionsStatus options={options} />
        )}
        {options.isLoading || products.length === 0 ? null : (
          <ul className="divide-y">
            {products.map((product) => (
              <li key={product.id} className="flex items-center gap-3 px-3 py-2">
                <ProductThumbnail image={product.primaryImage} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{product.name}</span>
                  <ProductOptionMeta product={product} />
                </span>
                {product.isActive === false ? <Badge variant="attention">{t("draft")}</Badge> : null}
              </li>
            ))}
            {query.hasNextPage ? (
              <li className="p-1.5">
                <Button type="button" variant="ghost" size="sm" className="w-full" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  {query.isFetchNextPageError ? tr("retry") : t("loadMore")}
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </section>
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
  const published = categories.filter((category) => category.status === "published");
  const addable = published.filter((category) => !selectedCategoryIds.includes(category.id));
  const unlistedCount = categories.filter((category) =>
    category.status !== "published" && !selectedCategoryIds.includes(category.id)).length;
  const previewCategoryIds = selectedCategories.filter((category) => category.status === "published").map((category) => category.id);
  const sources = [
    { value: "manual", label: t("pickProducts"), help: t("pickProductsHelp") },
    { value: "dynamic", label: t("automatic"), help: t("automaticHelp") },
  ] as const;
  const manual = selectedSource === "manual";

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
              {manual
                ? t(selectedProductIds.length === 1 ? "productsOfMaxOne" : "productsOfMax", { count: selectedProductIds.length, max: MAX_MEMBERSHIP_IDS })
                : t(selectedCategoryIds.length === 1 ? "categoriesOfMaxOne" : "categoriesOfMax", { count: selectedCategoryIds.length, max: MAX_MEMBERSHIP_IDS })}
            </span>
            {manual ? (
              <ProductPickerDialog
                selectedProductIds={selectedProductIds}
                onAddProducts={addProducts}
                maxProducts={MAX_MEMBERSHIP_IDS}
              />
            ) : published.length > 0 ? (
              <div className="w-full sm:w-64">
                <SearchableSelect
                  onValueChange={addCategory}
                  options={addable.map((category) => ({ value: category.id, label: category.name }))}
                  placeholder={addable.length > 0 ? t("addCategory") : t("allCategoriesAdded")}
                  searchPlaceholder={t("searchCategories")}
                  emptyMessage={t("noCategoriesMatch")}
                  ariaLabel={t("addCategory")}
                  disabled={addable.length === 0 || selectedCategoryIds.length >= MAX_MEMBERSHIP_IDS}
                />
              </div>
            ) : null}
          </div>
          {!manual && published.length === 0 ? (
            <p className="text-muted-foreground">
              {t("publishedOnly")}{" "}
              <Link to="/admin/categories" className="text-link hover:underline">
                {t("goToCategories")}
              </Link>
            </p>
          ) : !manual && unlistedCount > 0 ? (
            // Draft and hidden categories never feed a collection, so say why they're missing.
            <p className="text-muted-foreground">
              {t("unlistedCategories", { count: unlistedCount })}{" "}
              <Link to="/admin/categories" className="text-link hover:underline">
                {t("goToCategories")}
              </Link>
            </p>
          ) : null}

          {manual ? (
            <FormField
              control={form.control}
              name="config.productIds"
              render={() => (
                <FormItem>
                  {selectedProducts.length > 0 ? (
                    <ol className="divide-y rounded-lg border" aria-label={t("products")}>
                      {selectedProducts.map((product, index) => (
                        <li key={product.id} className="flex items-center gap-3 px-3 py-2">
                          <ProductThumbnail image={product.primaryImage} />
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
          {manual ? null : <RulePreview categoryIds={previewCategoryIds} />}
        </div>
      </CardContent>
    </Card>
  );
});
