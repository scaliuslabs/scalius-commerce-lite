import { queryOptions } from "@tanstack/react-query";
import {
  getProduct,
  getProducts,
  getProductsByIds,
  getProductStats,
  getProductVariants,
  type ProductsByIdsPayload,
  type ProductsQueryInput,
} from "../api-functions/products";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;
const EMPTY_PRODUCTS_BY_IDS: ProductsByIdsPayload = { products: [] };

function normalizeLookupIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

function normalizeProductsByIdsPayload(payload: unknown): ProductsByIdsPayload {
  const products = (payload as Partial<ProductsByIdsPayload> | null | undefined)
    ?.products;
  return { products: Array.isArray(products) ? products : [] };
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
        ? Promise.resolve(EMPTY_PRODUCTS_BY_IDS)
        : getProductsByIds({ data: { ids: normalizedIds } }).then(
            normalizeProductsByIdsPayload,
          ),
    placeholderData: EMPTY_PRODUCTS_BY_IDS,
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
