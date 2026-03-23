import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProductForm } from "~/components/admin/ProductForm";
import { VariantManager } from "~/components/admin/product-form/variants";
import { getProduct, getCategoryFormOptions } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/products/$productId/edit")({
  loader: async ({ params }) => {
    const [productResult, categoryResult] = await Promise.all([
      getProduct({ data: { id: params.productId } }).catch(() => null),
      getCategoryFormOptions(),
    ]);
    if (!productResult) throw redirect({ to: "/admin/products" });
    const product = productResult as any;
    const allCategories = (categoryResult as any).categories || [];
    const defaultValues = {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      categoryId: product.categoryId,
      slug: product.slug,
      metaTitle: product.metaTitle,
      metaDescription: product.metaDescription,
      isActive: product.isActive,
      discountType: (product.discountType || "percentage") as "percentage" | "flat",
      discountPercentage: product.discountPercentage || 0,
      discountAmount: product.discountAmount || 0,
      freeDelivery: product.freeDelivery,
      slugEdited: true,
      images: (product.images || []).map((img: any) => ({
        id: img.id,
        url: img.url,
        filename: img.altText || img.url.split("/").pop() || "",
        size: 0,
        createdAt: new Date(img.createdAt),
      })),
      attributes: product.attributes || [],
      additionalInfo: (product.additionalInfo || []).map((item: any) => ({
        id: item.id,
        title: item.title,
        content: item.content,
        sortOrder: item.sortOrder,
      })),
    };
    const formattedVariants = (product.variants || [])
      .filter((v: any) => !v.deletedAt)
      .map((v: any) => ({
        id: v.id,
        productId: v.productId,
        size: v.size,
        color: v.color,
        weight: v.weight,
        sku: v.sku || "",
        price: v.price ?? 0,
        stock: v.stock,
        reservedStock: v.reservedStock,
        barcode: v.barcode || null,
        barcodeType: v.barcodeType || null,
        discountType: (v.discountType || "percentage") as "percentage" | "flat",
        discountPercentage: v.discountPercentage || 0,
        discountAmount: v.discountAmount || 0,
        createdAt: new Date(v.createdAt),
        updatedAt: new Date(v.updatedAt),
        deletedAt: v.deletedAt ? new Date(v.deletedAt) : null,
      }));
    return { product, allCategories, defaultValues, formattedVariants };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Edit ${loaderData?.product?.name || "Product"} | Scalius Admin` }],
  }),
  component: EditProductPage,
});

function EditProductPage() {
  const { product, allCategories, defaultValues, formattedVariants } = Route.useLoaderData();

  return (
    <div className="container max-w-7xl space-y-6 py-4 pb-8">
      <ProductForm
        categories={allCategories}
        defaultValues={defaultValues}
        isEdit={true}
      />

      <div className="mt-6" id="variant-section">
        <VariantManager
          productId={product.id}
          productSlug={product.slug}
          productName={product.name}
          variants={formattedVariants}
        />
      </div>
    </div>
  );
}
