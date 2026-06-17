import { queryOptions } from "@tanstack/react-query";
import {
  getProduct,
  getProducts,
  getProductsByIds,
  getProductStats,
  getProductVariants,
  getVariantSortOrder,
  type ProductsQueryInput,
} from "../api-functions/products";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

function normalizeLookupIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

export const productsQueryOptions = (params: ProductsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.products.list(params),
    queryFn: () => getProducts({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const productsByIdsQueryOptions = (ids: readonly string[]) => {
  const normalizedIds = normalizeLookupIds(ids);
  return queryOptions({
    queryKey: queryKeys.products.byIds(normalizedIds),
    queryFn: () =>
      normalizedIds.length === 0
        ? Promise.resolve({ products: [] })
        : getProductsByIds({ data: { ids: normalizedIds } }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
};

export const productQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.products.detail(id),
    queryFn: () => getProduct({ data: { id } }),
    staleTime: 0,
  });

export const productStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.products.stats(),
    queryFn: () => getProductStats(),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const productVariantsQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variants(productId),
    queryFn: () => getProductVariants({ data: { productId } }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const variantSortOrderQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variantSortOrder(productId),
    queryFn: () => getVariantSortOrder({ data: { productId } }),
    staleTime: MODERATE_STALE_TIME_MS,
  });
