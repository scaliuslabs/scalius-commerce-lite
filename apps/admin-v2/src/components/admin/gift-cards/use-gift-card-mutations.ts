import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  patchApiV1AdminGiftCardsByGiftCardId,
  postApiV1AdminGiftCards,
  postApiV1AdminGiftCardsByGiftCardIdAdjust,
  postApiV1AdminGiftCardsByGiftCardIdResend,
} from "@scalius/api-client/sdk";

import { apiData, type ApiBody } from "~/lib/api";
import { giftCardKeys } from "~/lib/api-query-options/gift-cards";

export type IssueGiftCardInput = ApiBody<typeof postApiV1AdminGiftCards>;
export type AdjustGiftCardInput = ApiBody<typeof postApiV1AdminGiftCardsByGiftCardIdAdjust>;
export type UpdateGiftCardInput = ApiBody<typeof patchApiV1AdminGiftCardsByGiftCardId>;

function invalidate(queryClient: QueryClient, id?: string) {
  void queryClient.invalidateQueries({ queryKey: giftCardKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: giftCardKeys.summary() });
  if (id) void queryClient.invalidateQueries({ queryKey: giftCardKeys.detail(id) });
}

/**
 * Issues one card. The response carries the full code once: the dialog shows
 * it from the mutation result and never writes it to a query, the URL or a
 * log. `gcTime: 0` drops the finished mutation (and its code) from the
 * mutation cache as soon as the dialog stops observing it.
 */
export function useIssueGiftCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueGiftCardInput) => apiData(postApiV1AdminGiftCards({ body: input })),
    gcTime: 0,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useAdjustGiftCard(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AdjustGiftCardInput) => apiData(postApiV1AdminGiftCardsByGiftCardIdAdjust({ path: { giftCardId: id }, body: input })),
    // A refusal (balance changed) reloads the card too.
    onSettled: () => invalidate(queryClient, id),
  });
}

/** Status, expiry, customer and note under the card's `version` (a 409 means someone changed it). */
export function useUpdateGiftCard(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGiftCardInput) => apiData(patchApiV1AdminGiftCardsByGiftCardId({ path: { giftCardId: id }, body: input })),
    onSettled: () => invalidate(queryClient, id),
  });
}

export function useResendGiftCard(id: string) {
  return useMutation({
    mutationFn: () => apiData(postApiV1AdminGiftCardsByGiftCardIdResend({ path: { giftCardId: id } })),
  });
}
