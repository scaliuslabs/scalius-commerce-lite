import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminProducts,
  getApiV1AdminProductsById,
  getApiV1AdminProductsByIds,
  getApiV1AdminProductsByIdVariants,
  getApiV1AdminProductsStats,
  type postApiV1AdminProducts,
  type putApiV1AdminProductsByIdOptionsMatrix,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export type ProductsQuery = ApiQuery<typeof getApiV1AdminProducts>;
export type ProductListItemDto = ApiResult<typeof getApiV1AdminProducts>["products"][number];
export type ProductsByIdsPayload = ApiResult<typeof getApiV1AdminProductsByIds>;
type ApiProductDetail = ApiResult<typeof getApiV1AdminProductsById>;
type ApiProductVariant = ApiProductDetail["variants"][number];
/**
 * Contract gap: the shared variant schema (apps/api/src/schemas/entities.ts)
 * marks these optional; the product detail route always returns them.
 */
export type ProductVariant = ApiProductVariant &
  Required<Pick<ApiProductVariant, "selectedOptions" | "version" | "stockVersion">>;
export type ProductDetailDto = Omit<ApiProductDetail, "variants"> & {
  variants: ProductVariant[];
};
export type ProductOptionDefinition = ProductDetailDto["options"][number];
export type ProductOptionStandardMapping = ProductOptionDefinition["standardMapping"];
export type ProductMediaDetail = ProductDetailDto["media"][number];
export type ProductSkuImageChoice = Pick<
  ProductMediaDetail,
  "id" | "url" | "altText" | "isPrimary" | "sortOrder" | "status"
>;
export type CreateProductInput = ApiBody<typeof postApiV1AdminProducts>;
export type ProductOptionMatrixInput = ApiBody<typeof putApiV1AdminProductsByIdOptionsMatrix>;
export type ProductAggregateRevisionClaim = { id: string; expectedAggregateRevision: number };

const EMPTY_PRODUCTS_BY_IDS: ProductsByIdsPayload = { products: [] };

function normalizeLookupIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

/** The admin list always reads the compact projection. */
export const fetchProducts = (query: ProductsQuery) =>
  apiData(getApiV1AdminProducts({ query: { view: "compact", ...query } }));

export const fetchProductsByIds = (ids: readonly string[]) => {
  const normalizedIds = normalizeLookupIds(ids);
  return normalizedIds.length === 0
    ? Promise.resolve(EMPTY_PRODUCTS_BY_IDS)
    : apiData(getApiV1AdminProductsByIds({ query: { ids: normalizedIds.join(",") } }));
};

export const productsQueryOptions = (query: ProductsQuery) =>
  queryOptions({
    queryKey: queryKeys.products.list(query),
    queryFn: () => fetchProducts(query),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const productsByIdsQueryOptions = (ids: readonly string[]) => {
  const normalizedIds = normalizeLookupIds(ids);
  return queryOptions({
    queryKey: queryKeys.products.byIds(normalizedIds),
    queryFn: () => fetchProductsByIds(normalizedIds),
    placeholderData: EMPTY_PRODUCTS_BY_IDS,
    staleTime: LOOKUP_STALE_TIME_MS,
  });
};

export const productQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.products.detail(id),
    queryFn: async () =>
      (await apiData(getApiV1AdminProductsById({ path: { id } }))) as ProductDetailDto,
    staleTime: 0,
  });

export const productStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.products.stats(),
    queryFn: () => apiData(getApiV1AdminProductsStats()),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const productVariantsQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variants(productId),
    queryFn: () => apiData(getApiV1AdminProductsByIdVariants({ path: { id: productId } })),
    staleTime: MODERATE_STALE_TIME_MS,
  });
