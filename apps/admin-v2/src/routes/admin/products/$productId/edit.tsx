import { lazy, Suspense } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
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
  type Category,
} from "~/components/admin/product-form/types";
import type {
  ProductVariant as LocalProductVariant,
  VariantOptionLabels,
} from "~/components/admin/product-form/variants/types";
import { RouteErrorComponent } from "~/lib/route-error";
import { LoadingFallback } from "~/components/admin/shared/LoadingFallback";

const VariantManager = lazy(() =>
  import("~/components/admin/product-form/variants/VariantManager").then((module) => ({
    default: module.VariantManager,
  })),
);

export const Route = createFileRoute("/admin/products/$productId/edit")({
  loader: async ({ params, context: { queryClient } }) => {
    const [productResult] = await Promise.all([
      queryClient.ensureQueryData({ ...productQueryOptions(params.productId), staleTime: Infinity }).catch(() => null),
      queryClient.ensureQueryData(categoryFormOptionsQueryOptions()),
      queryClient.ensureQueryData(seoSettingsQueryOptions()).catch(() => null),
    ]);
    if (!productResult) throw redirect({ to: "/admin/products" });
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

  const defaultValues = {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    categoryId: product.categoryId,
    slug: product.slug,
    metaTitle: product.metaTitle,
    metaDescription: product.metaDescription,
    canonicalPath: product.canonicalPath,
    noIndex: product.noIndex,
    excludeFromSitemap: product.excludeFromSitemap,
    excludeFromProductFeed: product.excludeFromProductFeed,
    productCondition: product.productCondition ?? DEFAULT_PRODUCT_CONDITION,
    variantOption1Label:
      product.variantOption1Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option1,
    variantOption2Label:
      product.variantOption2Label ?? DEFAULT_PRODUCT_OPTION_LABELS.option2,
    variantOption1Schema:
      product.variantOption1Schema ?? DEFAULT_PRODUCT_OPTION_SCHEMA.option1,
    variantOption2Schema:
      product.variantOption2Schema ?? DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
    isActive: product.isActive,
    discountType: (product.discountType || "percentage") as "percentage" | "flat",
    discountPercentage: product.discountPercentage || 0,
    discountAmount: product.discountAmount || 0,
    freeDelivery: product.freeDelivery,
    slugEdited: true,
    images: (product.images || []).map((img: ProductImageDetail) => ({
      id: img.id,
      url: img.url,
      filename: img.alt ?? img.altText ?? img.url.split("/").pop() ?? "",
      size: 0,
      createdAt: new Date(img.createdAt),
    })),
    attributes: product.attributes || [],
    additionalInfo: (product.additionalInfo || []).map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      sortOrder: item.sortOrder,
    })),
  };

  const formattedVariants: LocalProductVariant[] = (product.variants || [])
    .filter((v: ProductVariant) => !v.deletedAt)
    .map((v: ProductVariant) => ({
      id: v.id,
      size: v.size,
      color: v.color,
      weight: v.weight,
      sku: v.sku || "",
      price: v.price ?? 0,
      stock: v.stock,
      reservedStock: v.reservedStock,
      isDefault: v.isDefault,
      trackInventory: v.trackInventory,
      barcode: v.barcode || null,
      barcodeType: (v.barcodeType || null) as LocalProductVariant["barcodeType"],
      discountType: (v.discountType || "percentage") as "percentage" | "flat",
      discountPercentage: v.discountPercentage || 0,
      discountAmount: v.discountAmount || 0,
      createdAt: new Date(v.createdAt),
      updatedAt: new Date(v.updatedAt),
      deletedAt: v.deletedAt ? new Date(v.deletedAt) : null,
    }));
  const variantOptionLabels: VariantOptionLabels = {
    option1: defaultValues.variantOption1Label,
    option2: defaultValues.variantOption2Label,
  };

  return (
    <div className="container max-w-7xl space-y-6 py-4 pb-8">
      <ProductForm
        categories={allCategories}
        defaultValues={defaultValues}
        isEdit={true}
      />

      <div className="mt-6" id="variant-section">
        {isHydrated ? (
          <Suspense fallback={<LoadingFallback height="h-48" />}>
            <VariantManager
              productId={product.id}
              productSlug={product.slug}
              productName={product.name}
              variants={formattedVariants}
              optionLabels={variantOptionLabels}
            />
          </Suspense>
        ) : (
          <LoadingFallback height="h-48" />
        )}
      </div>
    </div>
  );
}
