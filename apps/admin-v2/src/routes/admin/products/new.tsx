import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm } from "~/components/admin/ProductForm";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { DEFAULT_PRODUCT_CONDITION, type Category } from "~/components/admin/product-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import type { ProductOptionMatrixInput } from "~/lib/api-functions/products";

const OptionMatrixEditor = lazy(() =>
  import("~/components/admin/product-form/variants/OptionMatrixEditor").then((module) => ({
    default: module.OptionMatrixEditor,
  })),
);

const defaultValues = {
  name: "",
  description: null,
  price: 0,
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
  images: [],
};

export const Route = createFileRoute("/admin/products/new")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
  },
  head: () => ({ meta: [{ title: "New Product | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: NewProductPage,
});

function NewProductPage() {
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const allCategories = categoryData.categories as Category[];
  const [optionMatrixDraft, setOptionMatrixDraft] = useState<Omit<
    ProductOptionMatrixInput,
    "expectedAggregateRevision"
  > | null>(null);
  const [optionMatrixIssue, setOptionMatrixIssue] = useState<string | null>(null);
  const [optionMatrixDirty, setOptionMatrixDirty] = useState(false);

  return (
    <div className="container max-w-6xl py-4 pb-8">
      <ProductForm
        categories={allCategories}
        defaultValues={defaultValues}
        isEdit={false}
        optionMatrixDraft={optionMatrixDraft}
        optionMatrixIssue={optionMatrixIssue}
        optionMatrixDirty={optionMatrixDirty}
        optionManager={({ images, productName, productPrice }) => (
          <Suspense fallback={<LoadingFallback height="h-48" />}>
            <OptionMatrixEditor
              productName={productName}
              productPrice={productPrice}
              images={images}
              onDraftChange={setOptionMatrixDraft}
              onDraftIssueChange={setOptionMatrixIssue}
              onDirtyChange={setOptionMatrixDirty}
            />
          </Suspense>
        )}
      />
    </div>
  );
}
