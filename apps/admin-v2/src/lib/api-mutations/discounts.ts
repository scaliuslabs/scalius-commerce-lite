import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminDiscountsById,
  postApiV1AdminDiscounts,
  postApiV1AdminDiscountsByIdActivate,
  postApiV1AdminDiscountsByIdPause,
  putApiV1AdminDiscountsById,
} from "@scalius/api-client/sdk";

import { discountsMessages, type DiscountMessageKey } from "~/i18n/discounts";
import { translate } from "~/i18n";
import { readPromotionRevisionConflict } from "../admin-api-error";
import { apiData } from "../api";
import type { DiscountInput, DiscountUpdateInput } from "../api-query-options/discounts";
import { getServerFnError, queryKeys } from "./shared";

type RevisionClaim = { id: string; expectedRevision: number };
const t = (key: DiscountMessageKey) => translate(discountsMessages, key);

function invalidate(queryClient: QueryClient, id?: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
  if (id) void queryClient.invalidateQueries({ queryKey: queryKeys.discounts.detail(id) });
}

/** Revision conflicts are shown by the editor; other failures toast. */
function onFailure(error: unknown) {
  if (!readPromotionRevisionConflict(error)) toast.error(getServerFnError(error, t("saveFailed")));
}

/**
 * Creates the discount and, when the merchant may switch discounts on,
 * activates it straight away (Shopify saves new discounts as active).
 * The editor's save bar reports success and failure.
 */
export function useCreateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ input, activate }: { input: DiscountInput; activate: boolean }) => {
      const created = await apiData(postApiV1AdminDiscounts({ body: input }));
      if (!activate) return created;
      return apiData(postApiV1AdminDiscountsByIdActivate({
        path: { id: created.id },
        body: { expectedRevision: created.revision },
      })).catch((error: unknown) => {
        // Saved as a draft; the editor offers Activate with the reason.
        toast.error(getServerFnError(error, t("saveFailed")));
        return created;
      });
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function useUpdateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DiscountUpdateInput }) =>
      apiData(putApiV1AdminDiscountsById({ path: { id }, body: input })),
    onSuccess: (_result, { id }) => invalidate(queryClient, id),
  });
}

/** Callers toast success: once per discount in the editor, once per batch in the list. */
export function useSetDiscountActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision, active }: RevisionClaim & { active: boolean }) => {
      const command = active ? postApiV1AdminDiscountsByIdActivate : postApiV1AdminDiscountsByIdPause;
      return apiData(command({ path: { id }, body: { expectedRevision } }));
    },
    onSuccess: (_result, { id }) => invalidate(queryClient, id),
    onError: onFailure,
  });
}

export function useDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: RevisionClaim) =>
      apiData(deleteApiV1AdminDiscountsById({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_result, { id }) => {
      invalidate(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.discounts.detail(id) });
    },
    onError: onFailure,
  });
}
