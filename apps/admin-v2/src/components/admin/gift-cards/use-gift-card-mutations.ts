import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  patchApiV1AdminGiftCardsByGiftCardId,
  postApiV1AdminGiftCards,
  postApiV1AdminGiftCardsByGiftCardIdAdjust,
  postApiV1AdminGiftCardsByGiftCardIdResend,
  putApiV1AdminGiftCardsSettings,
} from "@scalius/api-client/sdk";

import { apiData, type ApiBody } from "~/lib/api";
import { giftCardKeys } from "~/lib/api-query-options/gift-cards";
import { announceSave, presenceKey } from "~/lib/realtime/store";
import { useCommand } from "~/lib/use-command";

// The command hook adds each request's `requestKey`.
export type IssueGiftCardInput = Omit<ApiBody<typeof postApiV1AdminGiftCards>, "requestKey">;
export type AdjustGiftCardInput = Omit<ApiBody<typeof postApiV1AdminGiftCardsByGiftCardIdAdjust>, "requestKey">;
export type UpdateGiftCardInput = ApiBody<typeof patchApiV1AdminGiftCardsByGiftCardId>;
export type GiftCardSettingsInput = ApiBody<typeof putApiV1AdminGiftCardsSettings>;

/** Saves what apps may add a day under the revision the dialog loaded (a 409 means someone changed it). */
export function useSaveGiftCardSettings() {
  const queryClient = useQueryClient();
  return useCommand({
    mutationFn: (input: GiftCardSettingsInput) => apiData(putApiV1AdminGiftCardsSettings({ body: input })),
    onSuccess: (saved) => queryClient.setQueryData(giftCardKeys.settings(), saved),
    onError: () => void queryClient.invalidateQueries({ queryKey: giftCardKeys.settings() }),
  });
}

function invalidate(queryClient: QueryClient, id?: string) {
  void queryClient.invalidateQueries({ queryKey: giftCardKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: giftCardKeys.summary() });
  if (id) void queryClient.invalidateQueries({ queryKey: giftCardKeys.detail(id) });
}

/**
 * Issues one card. The response carries the full code once: the dialog shows
 * it from the command's result, which lives only in the dialog's state, and
 * never writes it to a query, the URL or a log.
 */
export function useIssueGiftCard() {
  const queryClient = useQueryClient();
  return useCommand({
    name: "gift-cards.issue",
    mutationFn: (input: IssueGiftCardInput, requestKey) => apiData(postApiV1AdminGiftCards({ body: { ...input, requestKey } })),
    onSuccess: () => invalidate(queryClient),
  });
}

export function useAdjustGiftCard(id: string) {
  const queryClient = useQueryClient();
  return useCommand({
    name: "gift-cards.adjust",
    subject: () => id,
    mutationFn: (input: AdjustGiftCardInput, requestKey) =>
      apiData(postApiV1AdminGiftCardsByGiftCardIdAdjust({ path: { giftCardId: id }, body: { ...input, requestKey } })),
    onSuccess: ({ giftCard }) => announceSave(presenceKey("gift-card", id), giftCard.version),
    // A refusal (balance changed) reloads the card too.
    onSettled: () => invalidate(queryClient, id),
  });
}

/** Status, expiry, customer and note under the card's `version` (a 409 means someone changed it). */
export function useUpdateGiftCard(id: string) {
  const queryClient = useQueryClient();
  return useCommand({
    subject: () => id,
    mutationFn: (input: UpdateGiftCardInput) => apiData(patchApiV1AdminGiftCardsByGiftCardId({ path: { giftCardId: id }, body: input })),
    onSuccess: ({ giftCard }) => announceSave(presenceKey("gift-card", id), giftCard.version),
    onSettled: () => invalidate(queryClient, id),
  });
}

export function useResendGiftCard(id: string) {
  return useCommand({
    mutationFn: () => apiData(postApiV1AdminGiftCardsByGiftCardIdResend({ path: { giftCardId: id } })),
  });
}
