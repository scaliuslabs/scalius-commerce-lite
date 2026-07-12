import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm } from "~/components/admin/ProductForm";
import type { OptionMatrixEditorHandle } from "~/components/admin/product-form/variants/option-matrix-editor-model";
import { ProductRevisionConflictDialog } from "~/components/admin/product-form/ProductRevisionConflictDialog";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { productQueryOptions } from "~/lib/api-query-options/products";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import type { ProductDetail, ProductImageDetail } from "~/types/api-responses";
import {
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "~/components/admin/product-form/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { nullForAdminApiNotFound, type ProductRevisionConflict } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";

const OptionMatrixEditor = lazy(() =>
  import("~/components/admin/product-form/variants/OptionMatrixEditor").then((module) => ({
    default: module.OptionMatrixEditor,
  })),
);

export const Route = createFileRoute("/admin/products/$productId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [product] = await Promise.all([
      queryClient.fetchQuery({ ...productQueryOptions(params.productId), staleTime: 0 }).catch(nullForAdminApiNotFound),
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
    if (!product || (product as ProductDetail).deletedAt) throw redirect({ to: "/admin/products" });
  },
  head: () => ({ meta: [{ title: "Edit Product | Scalius Admin" }] }),
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
      setIsConflictOpen(false);
      requestAnimationFrame(() => document.getElementById("product-form-heading")?.focus());
    } catch (error) {
      setReloadLatestError(getServerFnError(error, "The latest product could not be loaded. Your draft is still here."));
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
      price: values.price,
      categoryId: values.categoryId,
      isActive: values.isActive,
      aggregateRevision: revision,
    }));
    setAggregateRevision(revision);
    if (matrixDirty) matrixRef.current?.save(revision);
    else void refreshMatrix();
  }, [matrixDirty, refreshMatrix]);

  const defaultValues = {
    id: formSnapshot.id,
    name: formSnapshot.name,
    description: formSnapshot.description,
    price: formSnapshot.price,
    categoryId: formSnapshot.categoryId,
    slug: formSnapshot.slug,
    metaTitle: formSnapshot.metaTitle,
    metaDescription: formSnapshot.metaDescription,
    canonicalPath: formSnapshot.canonicalPath,
    noIndex: formSnapshot.noIndex,
    excludeFromSitemap: formSnapshot.excludeFromSitemap,
    excludeFromProductFeed: formSnapshot.excludeFromProductFeed,
    productCondition: formSnapshot.productCondition ?? DEFAULT_PRODUCT_CONDITION,
    isActive: formSnapshot.isActive,
    discountType: (formSnapshot.discountType || "percentage") as "percentage" | "flat",
    discountPercentage: formSnapshot.discountPercentage || 0,
    discountAmount: formSnapshot.discountAmount || 0,
    freeDelivery: formSnapshot.freeDelivery,
    slugEdited: true,
    images: (formSnapshot.images || []).map((image: ProductImageDetail) => ({
      id: image.id,
      url: image.url,
      filename: image.alt ?? image.altText ?? image.url.split("/").pop() ?? "",
      size: 0,
      createdAt: new Date(image.createdAt),
    })),
    attributes: formSnapshot.attributes || [],
    additionalInfo: (formSnapshot.additionalInfo || []).map((item) => ({ ...item })),
  };

  return (
    <div className="container max-w-6xl space-y-4 py-4 pb-8">
      <ProductForm
        key={formGeneration}
        categories={categories}
        defaultValues={defaultValues}
        isEdit
        aggregateRevision={aggregateRevision}
        editorVariants={matrixSnapshot.variants}
        revisionConflict={revisionConflict}
        onAggregateRevisionChange={updateRevision}
        onRevisionConflict={(conflict) => {
          setRevisionConflict(conflict);
          setIsConflictOpen(true);
        }}
        onOpenRevisionConflict={() => setIsConflictOpen(true)}
        onProductSaved={handleProductSaved}
        optionMatrixIssue={matrixIssue}
        optionMatrixDirty={matrixDirty}
        optionMatrixSaving={matrixSaving}
        onOptionMatrixSave={() => matrixRef.current?.save()}
        optionManager={({ images, productName, productPrice }) => (
          <Suspense fallback={<LoadingFallback height="h-48" />}>
            <OptionMatrixEditor
              ref={matrixRef}
              key={`matrix-${matrixGeneration}`}
              productId={productId}
              productName={productName}
              productPrice={productPrice}
              options={matrixSnapshot.options}
              variants={matrixSnapshot.variants}
              images={images.filter((image) => !image.id.startsWith("temp_"))}
              aggregateRevision={aggregateRevision}
              onAggregateRevisionChange={updateRevision}
              onDirtyChange={setMatrixDirty}
              onDraftIssueChange={setMatrixIssue}
              onSavingChange={setMatrixSaving}
              onRevisionConflict={(conflict) => {
                setRevisionConflict(conflict);
                setIsConflictOpen(true);
              }}
              onSaved={() => void refreshMatrix()}
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
        onKeepDraft={() => setIsConflictOpen(false)}
        onReloadLatest={reloadLatest}
        onProductUnavailable={() => void navigate({ to: "/admin/products" })}
      />
    </div>
  );
}
