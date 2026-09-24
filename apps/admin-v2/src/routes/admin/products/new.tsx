import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm } from "~/components/admin/ProductForm";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { DEFAULT_PRODUCT_CONDITION, type Category } from "~/components/admin/product-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import type { OptionMatrixEditorHandle, ProductCreateComposition } from "~/components/admin/product-form/variants/option-matrix-editor-model";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";

const OptionMatrixEditor = lazy(() =>
  import("~/components/admin/product-form/variants/OptionMatrixEditor").then((module) => ({
    default: module.OptionMatrixEditor,
  })),
);

const defaultValues = {
  name: "",
  description: null,
  price: null,
  categoryId: "",
  isActive: false,
  discountType: "percentage" as "percentage" | "flat",
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  excludeFromProductFeed: false,
  productCondition: DEFAULT_PRODUCT_CONDITION,
  slug: "",
  media: [],
};

export const Route = createFileRoute("/admin/products/new")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
  },
  head: () => ({ meta: [{ title: `${translate(productMessages, "addProduct")} | Scalius Admin` }] }),
  errorComponent: RouteErrorComponent,
  component: NewProductPage,
});

function NewProductPage() {
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const allCategories = categoryData.categories as Category[];
  const [createComposition, setCreateComposition] = useState<ProductCreateComposition | null>(null);
  const [optionMatrixIssue, setOptionMatrixIssue] = useState<string | null>(null);
  const [optionMatrixDirty, setOptionMatrixDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  const matrixRef = useRef<OptionMatrixEditorHandle>(null);

  return (
    <ProductForm
      key={generation}
      categories={allCategories}
      defaultValues={defaultValues}
      isEdit={false}
      matrixRef={matrixRef}
      createComposition={createComposition}
      optionMatrixIssue={optionMatrixIssue}
      optionMatrixDirty={optionMatrixDirty}
      onDiscard={() => {
        setGeneration((value) => value + 1);
        setCreateComposition(null);
        setOptionMatrixIssue(null);
        setOptionMatrixDirty(false);
      }}
      optionManager={({ skuImages, productName, productPrice, isActive }) => (
        <Suspense fallback={<LoadingFallback height="h-48" />}>
          <OptionMatrixEditor
            ref={matrixRef}
            requirePositivePrice={isActive}
            productName={productName}
            productPrice={productPrice}
            images={skuImages}
            onDraftChange={setCreateComposition}
            onDraftIssueChange={setOptionMatrixIssue}
            onDirtyChange={setOptionMatrixDirty}
          />
        </Suspense>
      )}
    />
  );
}
