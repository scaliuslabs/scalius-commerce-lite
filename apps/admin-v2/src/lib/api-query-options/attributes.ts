import { queryOptions } from "@tanstack/react-query";
import {
  getAttributes,
  getAttributeValues,
  type AttributesQueryInput,
  type AttributeValuesQueryInput,
} from "../api-functions/attributes";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export const attributesQueryOptions = (params: AttributesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.attributes.list(params),
    queryFn: () => getAttributes({ data: params }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const attributeValuesQueryOptions = (params: AttributeValuesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.attributes.values(params),
    queryFn: () => getAttributeValues({ data: params }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });
