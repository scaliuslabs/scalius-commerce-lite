import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminBrands, getApiV1AdminBrandsById } from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

export type BrandsQuery = ApiQuery<typeof getApiV1AdminBrands>;
export type BrandListItem = ApiResult<typeof getApiV1AdminBrands>["brands"][number];
export type BrandDetail = ApiResult<typeof getApiV1AdminBrandsById>;

export const brandsQueryOptions = (query: BrandsQuery) =>
  queryOptions({
    queryKey: queryKeys.brands.list(query),
    queryFn: () => apiData(getApiV1AdminBrands({ query })),
    staleTime: 1000 * 60 * 2,
  });

export const brandQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.brands.detail(id),
    queryFn: () => apiData(getApiV1AdminBrandsById({ path: { id } })),
    staleTime: 0,
  });
