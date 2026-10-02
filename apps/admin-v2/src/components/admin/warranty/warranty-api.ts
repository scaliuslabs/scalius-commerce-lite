// Warranty reads and writes for the dashboard (Wave B §5.3): the policy list
// (Settings › Policies and the product editor's select), policy create/edit/
// archive/restore, one claim and its status change, and a staff-opened claim
// from the order page. Claims are records: nothing here moves money or stock.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminWarrantyPoliciesById,
  patchApiV1AdminWarrantyClaimsById,
  postApiV1AdminOrdersByIdWarrantyClaims,
  postApiV1AdminWarrantyPolicies,
  postApiV1AdminWarrantyPoliciesByIdRestore,
  putApiV1AdminWarrantyPoliciesById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "~/lib/api";
import { inboxKeys } from "~/lib/api-query-options/inbox";
import { queryKeys } from "~/lib/query-keys";
import { warrantyKeys } from "~/lib/api-query-options/warranty";

// The reads live with the other query options (a route loader starts them).
export {
  warrantyClaimQueryOptions,
  warrantyKeys,
  warrantyPoliciesQueryOptions,
  type WarrantyClaim,
  type WarrantyPolicy,
} from "~/lib/api-query-options/warranty";

export type WarrantyPolicyBody = ApiBody<typeof postApiV1AdminWarrantyPolicies>;
export type WarrantyClaimUpdate = ApiBody<typeof patchApiV1AdminWarrantyClaimsById>;

export function useSaveWarrantyPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string | null; version: number | null; body: WarrantyPolicyBody }) =>
      input.id
        ? apiData(putApiV1AdminWarrantyPoliciesById({ path: { id: input.id }, body: { ...input.body, version: input.version ?? 0 } }))
        : apiData(postApiV1AdminWarrantyPolicies({ body: input.body })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...warrantyKeys.all, "policies"] }),
  });
}

export function useArchiveWarrantyPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; archive: boolean }) =>
      input.archive
        ? apiData(deleteApiV1AdminWarrantyPoliciesById({ path: { id: input.id } }))
        : apiData(postApiV1AdminWarrantyPoliciesByIdRestore({ path: { id: input.id } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...warrantyKeys.all, "policies"] }),
  });
}

/** A status change (with an optional public reply); the thread gains an event line. */
export function useUpdateWarrantyClaim(claimId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: WarrantyClaimUpdate) =>
      (await apiData(patchApiV1AdminWarrantyClaimsById({ path: { id: claimId }, body }))).claim,
    onSuccess: (claim) => queryClient.setQueryData(warrantyKeys.claim(claimId), claim),
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: warrantyKeys.claim(claimId) }),
      queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
    ]),
  });
}

/** Staff open a claim for the buyer (also on an expired warranty: goodwill). */
export function useOpenWarrantyClaim(orderId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ApiBody<typeof postApiV1AdminOrdersByIdWarrantyClaims>) =>
      (await apiData(postApiV1AdminOrdersByIdWarrantyClaims({ path: { id: orderId }, body }))).claim,
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) }),
      queryClient.invalidateQueries({ queryKey: inboxKeys.all }),
    ]),
  });
}
