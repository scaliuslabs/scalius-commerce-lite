import { lazy, Suspense, useCallback, useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ProductForm } from "~/components/admin/ProductForm";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { productQueryOptions } from "~/lib/api-query-options/products";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { useHydrated } from "~/hooks/use-hydrated";
import type { ProductDetail, ProductImageDetail, ProductVariant } from "~/types/api-responses";
import {
  DEFAULT_PRODUCT_OPTION_LABELS,
  DEFAULT_PRODUCT_OPTION_SCHEMA,
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "~/components/admin/product-form/types";
import type {
  ProductVariant as LocalProductVariant,
  VariantOptionLabels,
} from "~/components/admin/product-form/variants/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";
import { nullForAdminApiNotFound } from "~/lib/admin-api-error";
import type { ProductRevisionConflict } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { ProductRevisionConflictDialog } from "~/components/admin/product-form/ProductRevisionConflictDialog";

const VariantManager = lazy(() =>
  import("~/components/admin/product-form/variants/VariantManager").then((module) => ({
    default: module.VariantManager,
  })),
);

function formatEditorVariants(product: ProductDetail): LocalProductVariant[] {
  return (product.variants || [])
    .filter((variant: ProductVariant) => !variant.deletedAt)
    .map((variant: ProductVariant) => ({
      id: variant.id,
      size: variant.size,
      color: variant.color,
      weight: variant.weight,
      sku: variant.sku || "",
      price: variant.price ?? 0,
      stock: variant.stock,
      reservedStock: variant.reservedStock,
      isDefault: variant.isDefault,
      trackInventory: variant.trackInventory,
      barcode: variant.barcode || null,
      barcodeType: (variant.barcodeType || null) as LocalProductVariant["barcodeType"],
      discountType: (variant.discountType || "percentage") as
        | "percentage"
        | "flat",
      discountPercentage: variant.discountPercentage || 0,
      discountAmount: variant.discountAmount || 0,
      createdAt: new Date(variant.createdAt),
      updatedAt: new Date(variant.updatedAt),
      deletedAt: variant.deletedAt ? new Date(variant.deletedAt) : null,
    }));
}

export const Route = createFileRoute("/admin/products/$productId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [productResult] = await Promise.all([
      queryClient
        .fetchQuery({
          ...productQueryOptions(params.productId),
          staleTime: 0,
        })
        .catch(nullForAdminApiNotFound),
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
    if (!productResult || (productResult as ProductDetail).deletedAt) {
      throw redirect({ to: "/admin/products" });
    }
  },
  head: () => ({
    meta: [{ title: `Edit Product | Scalius Admin` }],
  }),
  errorComponent: RouteErrorComponent,
  component: EditProductPage,
});

function EditProductPage() {
  const { productId } = Route.useParams();
  const isHydrated = useHydrated();
  const { data: productResult } = useSuspenseQuery(productQueryOptions(productId));
  const { data: categoryData } = useSuspenseQuery(categoryFormOptionsQueryOptions());

  const product = productResult as ProductDetail;
  const allCategories = categoryData.categories as Category[];

  return (
    <ProductEditor
      key={productId}
      productId={productId}
      initialProduct={product}
      categories={allCategories}
      isHydrated={isHydrated}
    />
  );
}

function ProductEditor({
  productId,
  initialProduct,
  categories,
  isHydrated,
}: {
  productId: string;
  initialProduct: ProductDetail;
  categories: Category[];
  isHydrated: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editorSnapshot, setEditorSnapshot] = useState(initialProduct);
  const [editorVariants, setEditorVariants] = useState<LocalProductVariant[]>(
    () => formatEditorVariants(initialProduct),
  );
  const [editorOptionLabels, setEditorOptionLabels] = useState<VariantOptionLabels>(() => ({
    option1:
      initialProduct.variantOption1Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option1,
    option2:
      initialProduct.variantOption2Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option2,
  }));
  const [currentAggregateRevision, setCurrentAggregateRevision] = useState(
    initialProduct.aggregateRevision,
  );
  const [formGeneration, setFormGeneration] = useState(0);
  const [revisionConflict, setRevisionConflict] =
    useState<ProductRevisionConflict | null>(null);
  const [isConflictOpen, setIsConflictOpen] = useState(false);
  const [isReloadingLatest, setIsReloadingLatest] = useState(false);
  const [reloadLatestError, setReloadLatestError] = useState<string | null>(null);

  const handleAggregateRevisionChange = useCallback((revision: number) => {
    setCurrentAggregateRevision((current) => Math.max(current, revision));
  }, []);

  const handleRevisionConflict = useCallback(
    (conflict: ProductRevisionConflict) => {
      setRevisionConflict(conflict);
      setReloadLatestError(null);
      setIsConflictOpen(true);
    },
    [],
  );

  const reloadLatest = useCallback(async () => {
    setIsReloadingLatest(true);
    setReloadLatestError(null);
    try {
      const latest = (await queryClient.fetchQuery({
        ...productQueryOptions(productId),
        staleTime: 0,
      })) as ProductDetail;
      if (latest.deletedAt) {
        void navigate({ to: "/admin/products" });
        return;
      }
      setEditorSnapshot(latest);
      setEditorVariants(formatEditorVariants(latest));
      setEditorOptionLabels({
        option1:
          latest.variantOption1Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option1,
        option2:
          latest.variantOption2Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option2,
      });
      setCurrentAggregateRevision(latest.aggregateRevision);
      setFormGeneration((generation) => generation + 1);
      setRevisionConflict(null);
      setIsConflictOpen(false);
      requestAnimationFrame(() => {
        document.getElementById("product-form-heading")?.focus();
      });
    } catch (error) {
      setReloadLatestError(
        getServerFnError(
          error,
          "The latest product could not be loaded. Your draft is still here.",
        ),
      );
    } finally {
      setIsReloadingLatest(false);
    }
  }, [navigate, productId, queryClient]);

  const handleProductSaved = useCallback(
    (values: ProductFormValues, aggregateRevision: number) => {
      setEditorSnapshot((current) => ({
        ...current,
        name: values.name,
        slug: values.slug,
        variantOption1Label: values.variantOption1Label,
        variantOption2Label: values.variantOption2Label,
        variantOption1Schema: values.variantOption1Schema,
        variantOption2Schema: values.variantOption2Schema,
        aggregateRevision,
      }));
      setCurrentAggregateRevision(aggregateRevision);
      setEditorOptionLabels({
        option1: values.variantOption1Label,
        option2: values.variantOption2Label,
      });
    },
    [],
  );

  const defaultValues = {
    id: editorSnapshot.id,
    name: editorSnapshot.name,
    description: editorSnapshot.description,
    price: editorSnapshot.price,
    categoryId: editorSnapshot.categoryId,
    slug: editorSnapshot.slug,
    metaTitle: editorSnapshot.metaTitle,
    metaDescription: editorSnapshot.metaDescription,
    canonicalPath: editorSnapshot.canonicalPath,
    noIndex: editorSnapshot.noIndex,
    excludeFromSitemap: editorSnapshot.excludeFromSitemap,
    excludeFromProductFeed: editorSnapshot.excludeFromProductFeed,
    productCondition:
      editorSnapshot.productCondition ?? DEFAULT_PRODUCT_CONDITION,
    variantOption1Label:
      editorSnapshot.variantOption1Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option1,
    variantOption2Label:
      editorSnapshot.variantOption2Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option2,
    variantOption1Schema:
      editorSnapshot.variantOption1Schema ?? DEFAULT_PRODUCT_OPTION_SCHEMA.option1,
    variantOption2Schema:
      editorSnapshot.variantOption2Schema ?? DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
    variantImagesEnabled: editorSnapshot.variantImagesEnabled,
    variantImageAxis: editorSnapshot.variantImageAxis,
    variantImageMappings: editorSnapshot.variantImageMappings.map((mapping) => ({
      imageId: mapping.imageId,
      variantId: mapping.variantId,
      optionAxis: mapping.optionAxis,
      optionValue: mapping.optionValue,
      sortOrder: mapping.sortOrder,
    })),
    isActive: editorSnapshot.isActive,
    discountType: (editorSnapshot.discountType || "percentage") as "percentage" | "flat",
    discountPercentage: editorSnapshot.discountPercentage || 0,
    discountAmount: editorSnapshot.discountAmount || 0,
    freeDelivery: editorSnapshot.freeDelivery,
    slugEdited: true,
    images: (editorSnapshot.images || []).map((img: ProductImageDetail) => ({
      id: img.id,
      url: img.url,
      filename: img.alt ?? img.altText ?? img.url.split("/").pop() ?? "",
      size: 0,
      createdAt: new Date(img.createdAt),
    })),
    attributes: editorSnapshot.attributes || [],
    additionalInfo: (editorSnapshot.additionalInfo || []).map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      sortOrder: item.sortOrder,
    })),
  };

  const optionManager = isHydrated ? (
    <Suspense fallback={<LoadingFallback height="h-48" />}>
      <VariantManager
        key={`option-editor-${formGeneration}`}
        productId={editorSnapshot.id}
        productSlug={editorSnapshot.slug}
        productName={editorSnapshot.name}
        variants={editorVariants}
        onVariantsChange={setEditorVariants}
        optionLabels={editorOptionLabels}
        aggregateRevision={currentAggregateRevision}
        revisionConflict={revisionConflict}
        onAggregateRevisionChange={handleAggregateRevisionChange}
        onRevisionConflict={handleRevisionConflict}
        onOpenRevisionConflict={() => setIsConflictOpen(true)}
        embedded
      />
    </Suspense>
  ) : (
    <LoadingFallback height="h-48" />
  );

  return (
    <div className="container max-w-6xl space-y-4 py-4 pb-8">
      <ProductForm
        key={formGeneration}
        categories={categories}
        defaultValues={defaultValues}
        isEdit={true}
        aggregateRevision={currentAggregateRevision}
        editorVariants={editorVariants}
        revisionConflict={revisionConflict}
        onAggregateRevisionChange={handleAggregateRevisionChange}
        onRevisionConflict={handleRevisionConflict}
        onOpenRevisionConflict={() => setIsConflictOpen(true)}
        onProductSaved={handleProductSaved}
        onOptionLabelsChange={setEditorOptionLabels}
        optionManager={optionManager}
      />
      <ProductRevisionConflictDialog
        open={isConflictOpen}
        conflict={revisionConflict}
        isReloading={isReloadingLatest}
        reloadError={reloadLatestError}
        onOpenChange={setIsConflictOpen}
        onKeepDraft={() => setIsConflictOpen(false)}
        onReloadLatest={reloadLatest}
        onProductUnavailable={() => {
          void navigate({ to: "/admin/products" });
        }}
      />
    </div>
  );
}
