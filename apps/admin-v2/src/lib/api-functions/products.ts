import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type Timestamp = string | number;
type NullableTimestamp = Timestamp | null;

export type ProductDiscountType = "percentage" | "flat";
export type BarcodeType = "ean13" | "upc" | "isbn" | "gtin" | "custom";

export interface PaginationPayload {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ProductsQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
}

export interface ProductListItemDto {
  id: string;
  name: string;
  slug: string;
  price: number;
  description: string | null;
  isActive: boolean;
  discountPercentage: number;
  discountType: ProductDiscountType;
  discountAmount: number;
  freeDelivery: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  category: { name: string };
  variantCount: number;
  imageCount: number;
  primaryImage: string | null;
  sku?: string;
}

export interface ProductPickerItemDto {
  id: string;
  name: string;
  price: number;
  categoryId: string | null;
  primaryImage: string | null;
  discountPercentage: number | null;
}

export interface ProductsListPayload {
  products: ProductListItemDto[];
  pagination: PaginationPayload;
}

export interface ProductsByIdsInput {
  ids: string[];
}

export interface ProductsByIdsPayload {
  products: ProductPickerItemDto[];
}

export interface ProductStatsPayload {
  totalProducts: number;
  activeProducts: number;
  productsWithImages: number;
  categoriesCount: number;
}

export interface ProductImageInput {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: string;
}

export interface ProductAttributeInput {
  attributeId: string;
  value: string;
}

export interface ProductAdditionalInfoInput {
  id: string;
  title: string;
  content: string;
  sortOrder: number;
}

export interface ProductWriteInput {
  name: string;
  description: string | null;
  price: number;
  categoryId: string;
  isActive: boolean;
  discountType: ProductDiscountType;
  discountPercentage: number | null | undefined;
  discountAmount: number | null | undefined;
  freeDelivery: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  slug: string;
  images: ProductImageInput[];
  attributes: ProductAttributeInput[];
  additionalInfo: ProductAdditionalInfoInput[];
}

export type CreateProductInput = ProductWriteInput;
export type UpdateProductInput = { id: string } & ProductWriteInput;

export interface ProductIdPayload {
  id: string;
}

export interface ProductImageDto {
  id: string;
  productId: string;
  url: string;
  alt: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Timestamp;
}

export interface ProductVariantDto {
  id: string;
  productId: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  reservedStock: number;
  preorderStock?: number;
  isDefault?: boolean;
  trackInventory?: boolean;
  lowStockThreshold?: number | null;
  allowPreorder?: boolean;
  preorderDate?: NullableTimestamp;
  preorderMessage?: string | null;
  allowBackorder?: boolean;
  backorderLimit?: number;
  discountPercentage: number | null;
  discountType: ProductDiscountType | string | null;
  discountAmount: number | null;
  barcode: string | null;
  barcodeType: string | null;
  colorSortOrder?: number | null;
  sizeSortOrder?: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: NullableTimestamp;
  stockVersion?: number;
  version?: number;
}

export interface ProductDetailDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  categoryId: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  isActive: boolean;
  discountPercentage: number | null;
  discountType: ProductDiscountType | null;
  discountAmount: number | null;
  freeDelivery: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: NullableTimestamp;
  category: { name: string | null } | null;
  variants: ProductVariantDto[];
  images: ProductImageDto[];
  additionalInfo: ProductAdditionalInfoInput[];
  attributes: ProductAttributeInput[];
}

export interface ProductVariantInput {
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  trackInventory?: boolean;
  barcode?: string | null;
  barcodeType?: BarcodeType | string | null;
  discountType?: ProductDiscountType;
  discountPercentage?: number | null;
  discountAmount?: number | null;
}

export interface BulkProductVariantInput extends ProductVariantInput {
  discountType: ProductDiscountType;
  discountPercentage: number | null;
  discountAmount: number | null;
  colorSortOrder?: number;
  sizeSortOrder?: number;
}

export interface ProductVariantUpdateInput {
  id: string;
  size?: string | null;
  color?: string | null;
  weight?: number | null;
  sku?: string;
  price?: number;
  stock?: number;
  trackInventory?: boolean;
  barcode?: string | null;
  barcodeType?: BarcodeType | string | null;
}

export interface ProductVariantsPayload {
  variants: ProductVariantDto[];
}

export interface BulkProductVariantsPayload {
  variants: ProductVariantDto[];
  count: number;
}

export interface VariantSortItem {
  value: string;
  sortOrder: number;
}

export interface VariantSortOrderPayload {
  colors: VariantSortItem[];
  sizes: VariantSortItem[];
}

export interface MessagePayload {
  message: string;
}

function toProductsParams(input: ProductsQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.categoryId) params.category = input.categoryId;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  if (input.showTrashed || input.trashed) params.trashed = "true";
  return params;
}

export const getProducts = createServerFn({ method: "GET" })
  .validator((data: ProductsQueryInput) => data)
  .handler(async ({ data }): Promise<ProductsListPayload> => {
    return apiGet<ProductsListPayload>("/products", toProductsParams(data));
  });

export const getProductsByIds = createServerFn({ method: "GET" })
  .validator((data: ProductsByIdsInput) => data)
  .handler(async ({ data }): Promise<ProductsByIdsPayload> => {
    const ids = Array.from(new Set(data.ids.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return { products: [] };
    return apiGet<ProductsByIdsPayload>("/products/by-ids", {
      ids: ids.join(","),
    });
  });

export const getProduct = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<ProductDetailDto> => {
    return apiGet<ProductDetailDto>(`/products/${data.id}`);
  });

export const getProductStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProductStatsPayload> => {
    return apiGet<ProductStatsPayload>("/products/stats");
  },
);

export const createProduct = createServerFn({ method: "POST" })
  .validator((data: CreateProductInput) => data)
  .handler(async ({ data }): Promise<ProductIdPayload> => {
    return apiPost<ProductIdPayload>("/products", data);
  });

export const updateProduct = createServerFn({ method: "POST" })
  .validator((data: UpdateProductInput) => data)
  .handler(async ({ data }): Promise<Record<string, never>> => {
    return apiPut<Record<string, never>>(`/products/${data.id}`, data);
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/products/${data.id}`);
  });

export const permanentDeleteProduct = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/products/${data.id}/permanent`);
  });

export const restoreProduct = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<Record<string, never>> => {
    return apiPost<Record<string, never>>(`/products/${data.id}/restore`);
  });

export const bulkDeleteProducts = createServerFn({ method: "POST" })
  .validator((data: { productIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/products/bulk-delete", data);
  });

export const getProductVariants = createServerFn({ method: "GET" })
  .validator((data: { productId: string }) => data)
  .handler(async ({ data }): Promise<ProductVariantsPayload> => {
    return apiGet<ProductVariantsPayload>(`/products/${data.productId}/variants`);
  });

export const createProductVariant = createServerFn({ method: "POST" })
  .validator(
    (data: { productId: string; variant: ProductVariantInput }) => data,
  )
  .handler(async ({ data }): Promise<ProductVariantDto> => {
    return apiPost<ProductVariantDto>(
      `/products/${data.productId}/variants`,
      data.variant,
    );
  });

export const updateProductVariant = createServerFn({ method: "POST" })
  .validator(
    (data: {
      productId: string;
      variantId: string;
      variant: ProductVariantInput;
    }) => data,
  )
  .handler(async ({ data }): Promise<ProductVariantDto> => {
    return apiPut<ProductVariantDto>(
      `/products/${data.productId}/variants/${data.variantId}`,
      data.variant,
    );
  });

export const deleteProductVariant = createServerFn({ method: "POST" })
  .validator((data: { productId: string; variantId: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/products/${data.productId}/variants/${data.variantId}`);
  });

export const bulkCreateProductVariants = createServerFn({ method: "POST" })
  .validator(
    (data: { productId: string; variants: BulkProductVariantInput[] }) => data,
  )
  .handler(async ({ data }): Promise<BulkProductVariantsPayload> => {
    return apiPost<BulkProductVariantsPayload>(
      `/products/${data.productId}/variants/bulk-create`,
      { variants: data.variants },
    );
  });

export const bulkUpdateProductVariants = createServerFn({ method: "POST" })
  .validator(
    (data: { productId: string; updates: ProductVariantUpdateInput[] }) => data,
  )
  .handler(async ({ data }): Promise<Record<string, never>> => {
    return apiPost<Record<string, never>>(
      `/products/${data.productId}/variants/bulk-update`,
      { updates: data.updates },
    );
  });

export const bulkDeleteProductVariants = createServerFn({ method: "POST" })
  .validator((data: { productId: string; variantIds: string[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>(`/products/${data.productId}/variants/bulk-delete`, {
      variantIds: data.variantIds,
    });
  });

export const duplicateProductVariant = createServerFn({ method: "POST" })
  .validator((data: { productId: string; variantId: string }) => data)
  .handler(async ({ data }): Promise<ProductVariantDto> => {
    return apiPost<ProductVariantDto>(
      `/products/${data.productId}/variants/${data.variantId}/duplicate`,
    );
  });

export const getVariantSortOrder = createServerFn({ method: "GET" })
  .validator((data: { productId: string }) => data)
  .handler(async ({ data }): Promise<VariantSortOrderPayload> => {
    return apiGet<VariantSortOrderPayload>(
      `/products/${data.productId}/variants/sort-order`,
    );
  });

export const updateVariantSortOrder = createServerFn({ method: "POST" })
  .validator(
    (data: { productId: string } & VariantSortOrderPayload) => data,
  )
  .handler(async ({ data }): Promise<MessagePayload> => {
    return apiPost<MessagePayload>(
      `/products/${data.productId}/variants/sort-order`,
      { colors: data.colors, sizes: data.sizes },
    );
  });
