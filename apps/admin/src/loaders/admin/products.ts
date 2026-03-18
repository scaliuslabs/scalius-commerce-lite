import { apiGet } from "@/lib/api-fetch";
import type {
  PaginationResponse,
  ProductStats,
  ProductListItem,
  ProductDetail,
  ProductVariant,
  ProductImageDetail,
} from "@/types/api-responses";

export async function getActiveCategories() {
  const result = await apiGet<{ categories: Array<{ id: string; name: string }> }>(
    "/categories/form-options",
  );
  return result.categories;
}

export async function getProductsIndexData(options: {
  page: number;
  limit: number;
  search: string;
  categoryId?: string;
  sort: "name" | "price" | "category" | "createdAt" | "updatedAt";
  order: "asc" | "desc";
  showTrashed: boolean;
}) {
  const params: Record<string, string> = {
    page: String(options.page),
    limit: String(options.limit),
    sort: options.sort,
    order: options.order,
  };
  if (options.search) params.search = options.search;
  if (options.categoryId) params.category = options.categoryId;
  if (options.showTrashed) params.trashed = "true";

  const [categoryOptions, productsResult, stats] = await Promise.all([
    getActiveCategories(),
    apiGet<{ products: ProductListItem[]; pagination: PaginationResponse }>("/products", params),
    apiGet<ProductStats>("/products/stats"),
  ]);

  // The API returns products with timestamp values — convert to Date for admin pages
  const formattedProducts = productsResult.products.map((product) => ({
    ...product,
    createdAt: new Date(product.createdAt),
    updatedAt: new Date(product.updatedAt),
  }));

  return {
    categories: categoryOptions,
    products: formattedProducts,
    pagination: productsResult.pagination,
    stats,
  };
}

export async function getProductEditData(id: string) {
  // GET /products/:id returns full product details
  const product = await apiGet<ProductDetail>("/products/" + id).catch(() => null);
  if (!product) return null;

  const allCategories = await getActiveCategories();

  // Build the defaultValues shape the edit form expects
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
    images: (product.images || []).map((img: ProductImageDetail) => ({
      id: img.id,
      url: img.url,
      filename: img.altText || img.url.split("/").pop() || "",
      size: 0,
      createdAt: new Date(img.createdAt),
    })),
    attributes: product.attributes || [],
    additionalInfo: (product.additionalInfo || []).map((item, idx) => ({
      id: `info-${idx}`,
      title: item.label,
      content: item.value,
    })),
  };

  const formattedVariants = (product.variants || [])
    .filter((v: ProductVariant) => !v.deletedAt)
    .map((variant: ProductVariant) => ({
      id: variant.id,
      productId: variant.productId,
      size: variant.size,
      color: variant.color,
      weight: variant.weight,
      sku: variant.sku || "",
      price: variant.price ?? 0,
      stock: variant.stock,
      reservedStock: variant.reservedStock,
      barcode: variant.barcode || null,
      barcodeType: (variant.barcodeType || null) as "ean13" | "upc" | "isbn" | "gtin" | "custom" | null,
      discountType: (variant.discountType || "percentage") as "percentage" | "flat",
      discountPercentage: variant.discountPercentage || 0,
      discountAmount: variant.discountAmount || 0,
      createdAt: new Date(variant.createdAt),
      updatedAt: new Date(variant.updatedAt),
      deletedAt: variant.deletedAt ? new Date(variant.deletedAt) : null,
    }));

  return {
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      categoryId: product.categoryId,
      slug: product.slug,
      metaTitle: product.metaTitle,
      metaDescription: product.metaDescription,
      isActive: product.isActive,
      discountType: product.discountType,
      discountPercentage: product.discountPercentage,
      discountAmount: product.discountAmount,
      freeDelivery: product.freeDelivery,
    },
    allCategories,
    defaultValues,
    formattedVariants,
  };
}

export async function getProductViewData(id: string) {
  const product = await apiGet<ProductDetail>("/products/" + id).catch(() => null);
  if (!product) return null;

  return {
    ...product,
    createdAt: new Date(product.createdAt),
    updatedAt: new Date(product.updatedAt),
    deletedAt: product.deletedAt ? new Date(product.deletedAt) : null,
    category: {
      name: product.category?.name || "Uncategorized",
    },
    variants: (product.variants || []).map((variant: ProductVariant) => ({
      ...variant,
      sku: variant.sku || "",
      price: variant.price ?? 0,
      reservedStock: variant.reservedStock ?? 0,
      createdAt: new Date(variant.createdAt),
      updatedAt: new Date(variant.updatedAt),
      deletedAt: variant.deletedAt ? new Date(variant.deletedAt) : null,
    })),
    images: (product.images || []).map((image: ProductImageDetail) => ({
      ...image,
      alt: image.altText,
      createdAt: new Date(image.createdAt),
    })),
    additionalInfo: product.additionalInfo || [],
  };
}
