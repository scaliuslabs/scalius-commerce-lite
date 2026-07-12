import { createServerFn } from "@tanstack/react-start";
import type { ProductCondition } from "@scalius/shared/product-condition";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type Timestamp = string | number;
type NullableTimestamp = Timestamp | null;

export type ProductDiscountType = "percentage" | "flat";
export type BarcodeType = "ean13" | "upc" | "isbn" | "gtin" | "code128" | "custom";

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
  aggregateRevision: number;
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
  mediaCount: number;
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

export interface ProductMediaInput {
  id: string;
  mediaId: string;
  altText: string | null;
  isPrimary: boolean;
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
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  excludeFromProductFeed: boolean;
  productCondition: ProductCondition;
  slug: string;
  media: ProductMediaInput[];
  attributes: ProductAttributeInput[];
  additionalInfo: ProductAdditionalInfoInput[];
  optionMatrix?: Omit<ProductOptionMatrixInput, "expectedAggregateRevision">;
}

export type CreateProductInput = ProductWriteInput;
export type UpdateProductInput = {
  id: string;
  expectedAggregateRevision: number;
  acknowledgedSkuImageRemovalIds?: string[];
} & ProductWriteInput;

export interface ProductAggregateRevisionResult {
  aggregateRevision: number;
}

export interface ProductAggregateRevisionClaim {
  id: string;
  expectedAggregateRevision: number;
}

export interface BulkDeleteProductsInput {
  products: ProductAggregateRevisionClaim[];
  permanent?: boolean;
}

export interface BulkDeleteProductsPayload {
  products: Array<{ id: string; aggregateRevision: number }>;
  deletedIds: string[];
  outcomes: Array<{
    id: string;
    status: "trashed" | "deleted" | "blocked" | "failed";
    code: string | null;
    message: string | null;
  }>;
}

export interface ProductIdPayload extends ProductAggregateRevisionResult {
  id: string;
}

export interface ProductMediaDto {
  id: string;
  mediaId: string;
  kind: "image" | "video";
  url: string;
  posterMediaId: string | null;
  posterUrl: string | null;
  altText: string;
  contextualAltText?: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
}

export interface ProductVariantDto {
  id: string;
  productId: string;
  optionCombinationKey: string | null;
  imageId: string | null;
  selectedOptions: SelectedProductOptionDto[];
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
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: NullableTimestamp;
  stockVersion?: number;
  version?: number;
}

export type ProductOptionStandardMapping = "size" | "color" | "material" | "pattern" | "none";

export interface ProductOptionValueDto {
  id: string;
  value: string;
  position: number;
}

export interface ProductOptionDefinitionDto {
  id: string;
  name: string;
  position: number;
  standardMapping: ProductOptionStandardMapping;
  values: ProductOptionValueDto[];
}

export interface SelectedProductOptionDto {
  optionDefinitionId: string;
  optionValueId: string;
  name: string;
  value: string;
  position: number;
  valuePosition: number;
  standardMapping: ProductOptionStandardMapping;
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
  canonicalPath: string | null;
  noIndex: boolean;
  excludeFromSitemap: boolean;
  excludeFromProductFeed: boolean;
  productCondition: ProductCondition | null;
  options: ProductOptionDefinitionDto[];
  aggregateRevision: number;
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
  media: ProductMediaDto[];
  additionalInfo: ProductAdditionalInfoInput[];
  attributes: ProductAttributeInput[];
}

export interface ProductVariantInput {
  selectedOptionValueIds: string[];
  imageId: string | null;
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

export interface ProductOptionMatrixInput {
  options: Array<{
    id: string;
    name: string;
    standardMapping: ProductOptionStandardMapping;
    values: Array<{ id: string; value: string }>;
  }>;
  variants: Array<{
    id: string;
    selectedOptionValueIds: string[];
    imageId: string | null;
    sku: string;
    price: number;
    stock: number;
    trackInventory: boolean;
    weight: number | null;
    barcode: string | null;
    barcodeType: BarcodeType | null;
    discountType: ProductDiscountType;
    discountPercentage: number | null;
    discountAmount: number | null;
  }>;
  expectedAggregateRevision: number;
}

export interface ProductVariantsPayload {
  variants: ProductVariantDto[];
}

export type ProductVariantMutationPayload = ProductVariantDto &
  ProductAggregateRevisionResult;

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
  .handler(async ({ data }): Promise<ProductAggregateRevisionResult> => {
    return apiPut<ProductAggregateRevisionResult>(`/products/${data.id}`, data);
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .validator((data: ProductAggregateRevisionClaim) => data)
  .handler(async ({ data }): Promise<ProductAggregateRevisionResult> => {
    return apiDelete<ProductAggregateRevisionResult>(
      `/products/${data.id}?expectedAggregateRevision=${data.expectedAggregateRevision}`,
    );
  });

export const permanentDeleteProduct = createServerFn({ method: "POST" })
  .validator((data: ProductAggregateRevisionClaim) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(
      `/products/${data.id}/permanent?expectedAggregateRevision=${data.expectedAggregateRevision}`,
    );
  });

export const restoreProduct = createServerFn({ method: "POST" })
  .validator((data: ProductAggregateRevisionClaim) => data)
  .handler(async ({ data }): Promise<ProductAggregateRevisionResult> => {
    return apiPost<ProductAggregateRevisionResult>(
      `/products/${data.id}/restore?expectedAggregateRevision=${data.expectedAggregateRevision}`,
    );
  });

export const bulkDeleteProducts = createServerFn({ method: "POST" })
  .validator((data: BulkDeleteProductsInput) => data)
  .handler(async ({ data }): Promise<BulkDeleteProductsPayload> => {
    return apiPost<BulkDeleteProductsPayload>("/products/bulk-delete", data);
  });

export const getProductVariants = createServerFn({ method: "GET" })
  .validator((data: { productId: string }) => data)
  .handler(async ({ data }): Promise<ProductVariantsPayload> => {
    return apiGet<ProductVariantsPayload>(`/products/${data.productId}/variants`);
  });

export const saveProductOptionMatrix = createServerFn({ method: "POST" })
  .validator((data: { productId: string; matrix: ProductOptionMatrixInput }) => data)
  .handler(async ({ data }): Promise<ProductAggregateRevisionResult> => {
    return apiPut<ProductAggregateRevisionResult>(
      `/products/${data.productId}/options/matrix`,
      data.matrix,
    );
  });

export const createProductVariant = createServerFn({ method: "POST" })
  .validator(
    (data: {
      productId: string;
      variant: ProductVariantInput;
      expectedAggregateRevision: number;
    }) => data,
  )
  .handler(async ({ data }): Promise<ProductVariantMutationPayload> => {
    return apiPost<ProductVariantMutationPayload>(
      `/products/${data.productId}/variants`,
      {
        ...data.variant,
        expectedAggregateRevision: data.expectedAggregateRevision,
      },
    );
  });

export const updateProductVariant = createServerFn({ method: "POST" })
  .validator(
    (data: {
      productId: string;
      variantId: string;
      variant: ProductVariantInput;
      expectedAggregateRevision: number;
    }) => data,
  )
  .handler(async ({ data }): Promise<ProductVariantMutationPayload> => {
    return apiPut<ProductVariantMutationPayload>(
      `/products/${data.productId}/variants/${data.variantId}`,
      {
        ...data.variant,
        expectedAggregateRevision: data.expectedAggregateRevision,
      },
    );
  });

export const deleteProductVariant = createServerFn({ method: "POST" })
  .validator((data: {
    productId: string;
    variantId: string;
    expectedAggregateRevision: number;
  }) => data)
  .handler(async ({ data }): Promise<ProductAggregateRevisionResult> => {
    return apiDelete<ProductAggregateRevisionResult>(
      `/products/${data.productId}/variants/${data.variantId}?expectedAggregateRevision=${data.expectedAggregateRevision}`,
    );
  });
