import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm } from "~/components/admin/ProductForm";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { salesChannelsQueryOptions } from "~/lib/api-query-options/sales-channels";
import { DEFAULT_PRODUCT_CONDITION, type Category } from "~/components/admin/product-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import type { OptionMatrixEditorHandle, ProductCreateComposition } from "~/components/admin/product-form/variants/option-matrix-editor-model";
import type { OptionMatrixDraftState } from "~/components/admin/product-form/variants/OptionMatrixEditor";
import { SkuCostProvider, useSkuCostDraft } from "~/components/admin/product-form/sku-costs";
import { pageHead } from "~/i18n/page-titles";

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
  shippingProfileId: null,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  salesChannelIds: null,
  productCondition: DEFAULT_PRODUCT_CONDITION,
  slug: "",
  media: [],
  fulfillmentKind: "physical" as const,
  customizationSchema: [],
};

const activeDefaultValues = { ...defaultValues, isActive: true };

export const Route = createFileRoute("/admin/products/new")({
  loader: async ({ context: { queryClient } }) => {
    const [, , channels] = await Promise.all([
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
      queryClient.ensureQueryData(salesChannelsQueryOptions()).catch(() => null),
    ]);
    // A new product starts Active, as Shopify's does, once the store sells
    // somewhere; a store whose every channel is off (or unreadable) starts it as a draft.
    return { startActive: Boolean(channels?.some((channel) => channel.status === "active")) };
  },
  head: () => pageHead("addProduct"),
  errorComponent: RouteErrorComponent,
  component: NewProductPage,
});

function NewProductPage() {
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const { startActive } = Route.useLoaderData();
  const allCategories = categoryData.categories as Category[];
  const [createComposition, setCreateComposition] = useState<ProductCreateComposition | null>(null);
  const [optionMatrixIssue, setOptionMatrixIssue] = useState<string | null>(null);
  const [optionMatrixDirty, setOptionMatrixDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  const matrixRef = useRef<OptionMatrixEditorHandle>(null);
  // The variant editor's draft, kept with the product's; a restore starts the editor again from it.
  const matrixDraft = useRef<OptionMatrixDraftState | null>(null);
  const [restoredMatrix, setRestoredMatrix] = useState<{ state: OptionMatrixDraftState; round: number } | null>(null);
  const keepMatrixDraft = useCallback((state: OptionMatrixDraftState) => { matrixDraft.current = state; }, []);
  // Costs typed here are sent right after the product is created (useProductSubmit).
  const costs = useSkuCostDraft();

  return (
    <SkuCostProvider store={costs}>
      <ProductForm
        key={generation}
        categories={allCategories}
        defaultValues={startActive ? activeDefaultValues : defaultValues}
        isEdit={false}
        matrixRef={matrixRef}
        createDraftVariants={{
          read: () => matrixDraft.current,
          restore: (state) => setRestoredMatrix((current) => ({ state: state as OptionMatrixDraftState, round: (current?.round ?? 0) + 1 })),
        }}
        createComposition={createComposition}
        optionMatrixIssue={optionMatrixIssue}
        optionMatrixDirty={optionMatrixDirty}
        onDiscard={() => {
          setGeneration((value) => value + 1);
          costs.reset();
          setCreateComposition(null);
          setOptionMatrixIssue(null);
          setOptionMatrixDirty(false);
          setRestoredMatrix(null);
        }}
        optionManager={({ readOnly, skuImages, productName, productPrice, productCompareAt, isActive, onPricesChange, fulfilmentMode }) => (
          <Suspense fallback={<LoadingFallback height="h-48" />}>
            <OptionMatrixEditor
              key={restoredMatrix?.round ?? 0}
              restoredDraft={restoredMatrix?.state ?? null}
              onDraftStateChange={keepMatrixDraft}
              readOnly={readOnly}
              ref={matrixRef}
              requirePositivePrice={isActive}
              productName={productName}
              productPrice={productPrice} productCompareAt={productCompareAt}
              onPricesChange={onPricesChange}
              images={skuImages}
              onDraftChange={setCreateComposition}
              onDraftIssueChange={setOptionMatrixIssue}
              onDirtyChange={setOptionMatrixDirty}
              fulfilmentMode={fulfilmentMode}
            />
          </Suspense>
        )}
      />
    </SkuCostProvider>
  );
}
