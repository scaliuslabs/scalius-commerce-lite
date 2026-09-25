import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminAttributes,
  getApiV1AdminAttributesByIdValues,
  getApiV1AdminAttributesCategorySetsByCategoryId,
  getApiV1AdminAttributesGroups,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export type AttributeDto = ApiResult<typeof getApiV1AdminAttributes>["attributes"][number];
export type AttributeValuesPayload = ApiResult<typeof getApiV1AdminAttributesByIdValues>;
type AttributeValuesQuery = ApiQuery<typeof getApiV1AdminAttributesByIdValues> & {
  attributeId?: string;
};

export const attributesQueryOptions = (query: ApiQuery<typeof getApiV1AdminAttributes>) =>
  queryOptions({
    queryKey: queryKeys.attributes.list(query),
    queryFn: () => apiData(getApiV1AdminAttributes({ query })),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export function getAttributeValues({ attributeId, ...query }: AttributeValuesQuery) {
  if (!attributeId) throw new Error("Attribute ID is required");
  return apiData(getApiV1AdminAttributesByIdValues({ path: { id: attributeId }, query }));
}

export const attributeValuesQueryOptions = (params: AttributeValuesQuery) =>
  queryOptions({
    queryKey: queryKeys.attributes.values(params),
    queryFn: () => getAttributeValues(params),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const attributeGroupsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.attributes.all, "groups"] as const,
    queryFn: () => apiData(getApiV1AdminAttributesGroups()),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export type AttributeGroupDto = ApiResult<typeof getApiV1AdminAttributesGroups>["groups"][number];

export const categoryAttributeSetQueryOptions = (categoryId: string) =>
  queryOptions({
    queryKey: [...queryKeys.attributes.all, "category-set", categoryId] as const,
    queryFn: () => apiData(getApiV1AdminAttributesCategorySetsByCategoryId({ path: { categoryId } })),
    staleTime: 0,
  });

export type CategoryAttributeSetEntry = ApiResult<typeof getApiV1AdminAttributesCategorySetsByCategoryId>["attributes"][number];
