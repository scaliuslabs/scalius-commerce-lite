import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm, type ProductDraftReader } from "~/components/admin/ProductForm";
import { productFieldLabel } from "~/components/admin/product-form/utils";
import type { OptionMatrixEditorHandle } from "~/components/admin/product-form/variants/option-matrix-editor-model";
import { ProductRevisionConflictDialog } from "~/components/admin/product-form/ProductRevisionConflictDialog";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { productQueryOptions } from "~/lib/api-query-options/products";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import type {
  ProductDetailDto as ProductDetail,
} from "~/lib/api-query-options/products";
import {
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "~/components/admin/product-form/types";
import { draftsFromView, viewFromDrafts } from "~/components/admin/product-form/buyer-inputs";
import { fulfilmentModeOf } from "~/components/admin/product-form/fulfilment-mode";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound, type ProductRevisionConflict } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { pageHead } from "~/i18n/page-titles";
import { INTENT_PREFETCH_MOUNT_GRACE_MS } from "~/lib/route-query-warming";

const OptionMatrixEditor = lazy(() =>
  import("~/components/admin/product-form/variants/OptionMatrixEditor").then((module) => ({
    default: module.OptionMatrixEditor,
  })),
);

export const Route = createFileRoute("/admin/products/$productId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [product] = await Promise.all([
      // Fresh on open; a read the link's hover started a moment ago counts as
      // fresh, so the click doesn't fetch the whole product again. A save
      // invalidates it, and the server checks the revision on every write.
      queryClient.fetchQuery({ ...productQueryOptions(params.productId), staleTime: INTENT_PREFETCH_MOUNT_GRACE_MS }).catch(nullForAdminApiNotFound),
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
    if (!product || (product as ProductDetail).deletedAt) throw redirect({ to: "/admin/products" });
  },
  head: () => pageHead("product"),
  errorComponent: RouteErrorComponent,
  component: EditProductPage,
});

function EditProductPage() {
  const { productId } = Route.useParams();
  const { data: product } = useSuspenseQuery(productQueryOptions(productId));
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  return (
    <ProductEditor
      key={productId}
      productId={productId}
      initialProduct={product as ProductDetail}
      categories={categoryData.categories as Category[]}
    />
  );
}

/** The editor's values for a saved product. */
function toFormValues(product: ProductDetail): ProductFormValues {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    categoryId: product.categoryId ?? "",
    slug: product.slug,
    metaTitle: product.metaTitle,
    metaDescription: product.metaDescription,
    canonicalPath: product.canonicalPath,
    noIndex: product.noIndex,
    excludeFromSitemap: product.excludeFromSitemap,
    excludeFromProductFeed: product.excludeFromProductFeed,
    productCondition: product.productCondition ?? DEFAULT_PRODUCT_CONDITION,
    isActive: product.isActive,
    discountType: (product.discountType || "percentage") as "percentage" | "flat",
    discountPercentage: product.discountPercentage || 0,
    discountAmount: product.discountAmount || 0,
    freeDelivery: product.freeDelivery,
    slugEdited: true,
    media: [...(product.media || [])]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((item) => ({
        ...item,
        effectiveAltText: item.altText,
        altText: item.contextualAltText ?? "",
      })),
    attributes: product.attributes || [],
    additionalInfo: (product.additionalInfo || []).map((item) => ({ ...item })),
    fulfillmentKind: fulfilmentModeOf(product.variants),
    isGiftCard: product.isGiftCard,
    warrantyPolicyId: product.warrantyPolicyId ?? null,
    brandId: product.brandId ?? null,
    customizationSchema: draftsFromView(product.customizationSchema),
  } as ProductFormValues;
}

/** Options and SKUs as saved, to tell whether someone else changed them. */
function variantsSignature(product: ProductDetail): string {
  return JSON.stringify([product.options, product.variants]);
}

function ProductEditor({ productId, initialProduct, categories }: {
  productId: string;
  initialProduct: ProductDetail;
  categories: Category[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [formSnapshot, setFormSnapshot] = useState(initialProduct);
  const [matrixSnapshot, setMatrixSnapshot] = useState(initialProduct);
  const [matrixGeneration, setMatrixGeneration] = useState(0);
  const [aggregateRevision, setAggregateRevision] = useState(initialProduct.aggregateRevision);
  const [formGeneration, setFormGeneration] = useState(0);
  const [revisionConflict, setRevisionConflict] = useState<ProductRevisionConflict | null>(null);
  const [isConflictOpen, setIsConflictOpen] = useState(false);
  const [isReloadingLatest, setIsReloadingLatest] = useState(false);
  const [reloadLatestError, setReloadLatestError] = useState<string | null>(null);
  const [matrixDirty, setMatrixDirty] = useState(false);
  const [matrixSaving, setMatrixSaving] = useState(false);
  const [matrixIssue, setMatrixIssue] = useState<string | null>(null);
  const matrixRef = useRef<OptionMatrixEditorHandle>(null);
  const draftRef = useRef<ProductDraftReader | null>(null);
  // The merchant's changed fields, put back on top of the latest version after a conflict.
  const [pendingEdits, setPendingEdits] = useState<Partial<ProductFormValues> | null>(null);
  // Fields both people changed: the merchant's edits can't be applied automatically.
  const [overlap, setOverlap] = useState<string[] | null>(null);

  const updateRevision = useCallback((revision: number) => {
    setAggregateRevision((current) => Math.max(current, revision));
  }, []);

  const reloadLatest = useCallback(async () => {
    setIsReloadingLatest(true);
    setReloadLatestError(null);
    try {
      const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
      if (latest.deletedAt) {
        void navigate({ to: "/admin/products" });
        return;
      }
      setFormSnapshot(latest);
      setMatrixSnapshot(latest);
      setAggregateRevision(latest.aggregateRevision);
      setFormGeneration((value) => value + 1);
      setMatrixGeneration((value) => value + 1);
      setMatrixDirty(false);
      setMatrixIssue(null);
      setRevisionConflict(null);
      setPendingEdits(null);
      setOverlap(null);
      setIsConflictOpen(false);
    } catch (error) {
      setReloadLatestError(getServerFnError(error, translate(productMessages, "reloadFailed")));
    } finally {
      setIsReloadingLatest(false);
    }
  }, [navigate, productId, queryClient]);

  const refreshMatrix = useCallback(async () => {
    const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
    setMatrixSnapshot(latest);
    setAggregateRevision(latest.aggregateRevision);
    setMatrixGeneration((value) => value + 1);
  }, [productId, queryClient]);

  const handleProductSaved = useCallback((values: ProductFormValues, revision: number) => {
    setFormSnapshot((current) => ({
      ...current,
      name: values.name,
      slug: values.slug,
      description: values.description,
      price: values.price ?? 0,
      categoryId: values.categoryId,
      brandId: values.brandId,
      isActive: values.isActive,
      media: values.media.map(({ effectiveAltText, altText, ...item }) => ({
        ...item,
        altText: altText.trim() || effectiveAltText,
        contextualAltText: altText.trim() || null,
      })),
      customizationSchema: viewFromDrafts(values.customizationSchema) as ProductDetail["customizationSchema"],
      // One kind for the product: every live SKU now has it (a later conflict compares against this).
      variants: values.fulfillmentKind === "mixed"
        ? current.variants
        : current.variants.map((variant) => (variant.deletedAt ? variant : { ...variant, fulfillmentKind: values.fulfillmentKind as "physical" | "service" })),
      aggregateRevision: revision,
    }));
    setAggregateRevision(revision);
    // A variant draft is saved next by the page, against this new revision.
    if (!matrixDirty) void refreshMatrix();
  }, [matrixDirty, refreshMatrix]);

  const defaultValues = toFormValues(formSnapshot);

  /**
   * "Apply my changes": load the other save and put the merchant's changed fields back on
   * top, still unsaved. When the other save changed the same fields (or the variants the
   * merchant is editing), nothing is applied; the dialog names those fields instead.
   */
  const applyMineToLatest = useCallback(async () => {
    const draft = draftRef.current?.();
    if (!draft) return;
    setIsReloadingLatest(true);
    setReloadLatestError(null);
    try {
      const latest = await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 }) as ProductDetail;
      if (latest.deletedAt) {
        void navigate({ to: "/admin/products" });
        return;
      }
      const before = toFormValues(formSnapshot);
      const after = toFormValues(latest);
      const same = (key: keyof ProductFormValues) => JSON.stringify(before[key]) === JSON.stringify(after[key]);
      const clashes = draft.changed.filter((key) => !same(key));
      const variantsChanged = matrixDirty && variantsSignature(matrixSnapshot) !== variantsSignature(latest);
      if (clashes.length > 0 || variantsChanged) {
        setOverlap([...clashes.map(productFieldLabel), ...(variantsChanged ? [translate(productMessages, "variants")] : [])]);
        return;
      }
      setFormSnapshot(latest);
      setAggregateRevision(latest.aggregateRevision);
      setPendingEdits(Object.fromEntries(draft.changed.map((key) => [key, draft.values[key]])));
      setFormGeneration((value) => value + 1);
      if (!matrixDirty) {
        setMatrixSnapshot(latest);
        setMatrixGeneration((value) => value + 1);
      }
      setRevisionConflict(null);
      setIsConflictOpen(false);
    } catch (error) {
      setReloadLatestError(getServerFnError(error, translate(productMessages, "reloadFailed")));
    } finally {
      setIsReloadingLatest(false);
    }
  }, [formSnapshot, matrixDirty, matrixSnapshot, navigate, productId, queryClient]);

  return (
    <>
      <ProductForm
        key={formGeneration}
        categories={categories}
        defaultValues={defaultValues}
        isEdit
        aggregateRevision={aggregateRevision}
        revisionConflict={revisionConflict}
        onAggregateRevisionChange={updateRevision}
        onRevisionConflict={(conflict) => {
          setRevisionConflict(conflict);
          setOverlap(null);
          setIsConflictOpen(true);
        }}
        onOpenRevisionConflict={() => setIsConflictOpen(true)}
        draftRef={draftRef}
        initialEdits={pendingEdits}
        onProductSaved={handleProductSaved}
        optionMatrixIssue={matrixIssue}
        optionMatrixDirty={matrixDirty}
        optionMatrixSaving={matrixSaving}
        matrixRef={matrixRef}
        variantIds={matrixSnapshot.variants.filter((variant) => !variant.deletedAt).map((variant) => variant.id)}
        customizationSchemaInvalid={formSnapshot.customizationSchemaInvalid}
        brandName={formSnapshot.brandName}
        onDiscard={() => {
          if (revisionConflict) {
            void reloadLatest();
            return;
          }
          setFormGeneration((value) => value + 1);
          setMatrixGeneration((value) => value + 1);
          setMatrixDirty(false);
          setMatrixIssue(null);
        }}
        optionManager={({ skuImages, productName, productPrice, isActive, onPricesChange, fulfilmentMode }) => (
          <Suspense fallback={<LoadingFallback height="h-48" />}>
            <OptionMatrixEditor
              requirePositivePrice={isActive}
              ref={matrixRef}
              key={`matrix-${matrixGeneration}`}
              productId={productId}
              productName={productName}
              productPrice={productPrice}
              onPricesChange={onPricesChange}
              options={matrixSnapshot.options}
              variants={matrixSnapshot.variants}
              images={skuImages}
              aggregateRevision={aggregateRevision}
              onAggregateRevisionChange={updateRevision}
              onDirtyChange={setMatrixDirty}
              onDraftIssueChange={setMatrixIssue}
              onSavingChange={setMatrixSaving}
              onRevisionConflict={(conflict) => {
                setRevisionConflict(conflict);
                setOverlap(null);
                setIsConflictOpen(true);
              }}
              onSaved={() => void refreshMatrix()}
              fulfilmentMode={fulfilmentMode}
            />
          </Suspense>
        )}
      />
      <ProductRevisionConflictDialog
        open={isConflictOpen}
        conflict={revisionConflict}
        isReloading={isReloadingLatest}
        reloadError={reloadLatestError}
        onOpenChange={setIsConflictOpen}
        changedFields={isConflictOpen ? (draftRef.current?.().changed ?? []).map(productFieldLabel) : []}
        variantsChanged={matrixDirty}
        overlap={overlap}
        onApplyMine={applyMineToLatest}
        onReloadLatest={reloadLatest}
        onProductUnavailable={() => void navigate({ to: "/admin/products" })}
      />
    </>
  );
}
