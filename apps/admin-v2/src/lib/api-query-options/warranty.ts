// Warranty reads (Wave B §5.3), apart from the writes in
// components/admin/warranty/warranty-api.ts: a route loader may start them,
// and loaders are part of the dashboard's first download.
import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminWarrantyClaimsById, getApiV1AdminWarrantyPolicies } from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "~/lib/api";

export type WarrantyPolicy = ApiResult<typeof getApiV1AdminWarrantyPolicies>["items"][number];
export type WarrantyClaim = ApiResult<typeof getApiV1AdminWarrantyClaimsById>["claim"];

export const warrantyKeys = {
  all: ["warranty"] as const,
  policies: (archived: boolean) => [...warrantyKeys.all, "policies", archived] as const,
  claim: (id: string) => [...warrantyKeys.all, "claim", id] as const,
};

/** Policies by name with their product counts; archived ones last when asked for. */
export const warrantyPoliciesQueryOptions = (archived = false) =>
  queryOptions({
    queryKey: warrantyKeys.policies(archived),
    queryFn: async () =>
      (await apiData(getApiV1AdminWarrantyPolicies(archived ? { query: { archived: "include" } } : undefined))).items,
    staleTime: 30_000,
  });

export const warrantyClaimQueryOptions = (id: string) =>
  queryOptions({
    queryKey: warrantyKeys.claim(id),
    queryFn: async () => (await apiData(getApiV1AdminWarrantyClaimsById({ path: { id } }))).claim,
    staleTime: 0,
  });
