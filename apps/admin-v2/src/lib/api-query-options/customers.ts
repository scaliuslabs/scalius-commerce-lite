import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminCustomers,
  getApiV1AdminCustomersById,
  getApiV1AdminCustomersByIdHistory,
  getApiV1AdminCustomersByIdMarketing,
  getApiV1AdminCustomersByIdPaymentMethods,
  getApiV1AdminCustomersSegments,
  getApiV1AdminCustomersSegmentsBySegmentId,
  getApiV1AdminCustomersSegmentsBySegmentIdCount,
  getApiV1AdminCustomersTags,
  postApiV1AdminCustomersSegmentsPreview,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;
/** Segment member counts are one bounded query each: keep them a minute. */
const SEGMENT_COUNT_STALE_TIME_MS = 1000 * 60;

export type CustomersListPayload = ApiResult<typeof getApiV1AdminCustomers>;
export type CustomersQuery = ApiQuery<typeof getApiV1AdminCustomers>;
export type CustomerDto = ApiResult<typeof getApiV1AdminCustomersById>;
type CustomerHistoryQuery = ApiQuery<typeof getApiV1AdminCustomersByIdHistory>;
export type CustomerMarketing = ApiResult<typeof getApiV1AdminCustomersByIdMarketing>;
export type CustomerConsent = CustomerMarketing["consents"][number];
export type CustomerConsentEvent = CustomerMarketing["events"][number];
export type CustomerSavedPaymentMethod = ApiResult<typeof getApiV1AdminCustomersByIdPaymentMethods>["paymentMethods"][number];
export type CustomerTagCount = ApiResult<typeof getApiV1AdminCustomersTags>["tags"][number];
export type CustomerSegment = ApiResult<typeof getApiV1AdminCustomersSegmentsBySegmentId>;
export type CustomerSegmentDefinitionBody = ApiBody<typeof postApiV1AdminCustomersSegmentsPreview>["definition"];
export type CustomerSegmentPreview = ApiResult<typeof postApiV1AdminCustomersSegmentsPreview>;

export const customersQueryOptions = (query: CustomersQuery) =>
  queryOptions({
    queryKey: queryKeys.customers.list(query),
    queryFn: () => apiData(getApiV1AdminCustomers({ query })),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const customerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.detail(id),
    queryFn: () => apiData(getApiV1AdminCustomersById({ path: { id } })),
    staleTime: 0,
  });

export const fetchCustomerHistory = (id: string, query: CustomerHistoryQuery) =>
  apiData(getApiV1AdminCustomersByIdHistory({ path: { id }, query }));

/** Tags in use, most used first; `q` (typed text) goes in the request, never in a page URL. */
export const fetchCustomerTags = (q: string, limit = 20, signal?: AbortSignal) =>
  apiData(getApiV1AdminCustomersTags({ query: { ...(q ? { q } : {}), limit }, signal }));

export const customerTagsQueryOptions = (q: string) =>
  queryOptions({
    queryKey: queryKeys.customers.tags(q),
    queryFn: ({ signal }) => fetchCustomerTags(q, 20, signal),
    staleTime: MODERATE_STALE_TIME_MS,
  });

/** One customer's consent per channel (for the current address), consent log and tags. */
export const customerMarketingQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.marketing(id),
    queryFn: () => apiData(getApiV1AdminCustomersByIdMarketing({ path: { id } })),
    staleTime: 0,
  });

/** The cards or wallets a provider kept for this customer, oldest first. */
export const customerPaymentMethodsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.paymentMethods(id),
    queryFn: () => apiData(getApiV1AdminCustomersByIdPaymentMethods({ path: { id } })),
    staleTime: 0,
  });

export const customerSegmentsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.customers.segments(),
    queryFn: () => apiData(getApiV1AdminCustomersSegments()),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const customerSegmentQueryOptions = (segmentId: string) =>
  queryOptions({
    queryKey: queryKeys.customers.segment(segmentId),
    queryFn: () => apiData(getApiV1AdminCustomersSegmentsBySegmentId({ path: { segmentId } })),
    staleTime: 0,
  });

/** Live member count; `capped` means "100,000 or more". */
export const customerSegmentCountQueryOptions = (segmentId: string) =>
  queryOptions({
    queryKey: queryKeys.customers.segmentCount(segmentId),
    queryFn: () => apiData(getApiV1AdminCustomersSegmentsBySegmentIdCount({ path: { segmentId } })),
    staleTime: SEGMENT_COUNT_STALE_TIME_MS,
  });

/** Count and first customers of an unsaved definition (changes nothing). */
export const customerSegmentPreviewQueryOptions = (definition: CustomerSegmentDefinitionBody) =>
  queryOptions({
    queryKey: queryKeys.customers.segmentPreview(definition),
    queryFn: ({ signal }) => apiData(postApiV1AdminCustomersSegmentsPreview({ body: { definition }, signal })),
    staleTime: SEGMENT_COUNT_STALE_TIME_MS,
  });
