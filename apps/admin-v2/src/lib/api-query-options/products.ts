import { queryOptions } from "@tanstack/react-query";
import {
  getProducts,
  getProductStats,
  type ProductsQueryInput,
} from "../api-functions/products";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const productsQueryOptions = (params: ProductsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.products.list(params),
    queryFn: () => getProducts({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const productStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.products.stats(),
    queryFn: () => getProductStats(),
    staleTime: MODERATE_STALE_TIME_MS,
  });
