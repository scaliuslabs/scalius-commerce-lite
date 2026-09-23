import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { readPromotionRevisionConflict } from "../admin-api-error";

import {
  deleteApiV1AdminPromotionsById,
  postApiV1AdminPromotions,
  postApiV1AdminPromotionsByIdActivate,
  postApiV1AdminPromotionsByIdPause,
  postApiV1AdminPromotionsByIdPreview,
  putApiV1AdminPromotionsById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import type {
  CreatePromotionDraftInput,
  UpdatePromotionDraftInput,
} from "../api-query-options/promotions";

type PromotionRevisionClaim = { id: string; expectedRevision: number };
import { getServerFnError, queryKeys } from "./shared";

function invalidatePromotion(
  queryClient: QueryClient,
  id?: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.promotions.list(),
  });
  if (id) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.promotions.detail(id),
    });
  }
}

function handlePromotionMutationError(
  error: unknown,
  queryClient: QueryClient,
  id: string | undefined,
  fallback: string,
): void {
  if (readPromotionRevisionConflict(error)) {
    invalidatePromotion(queryClient, id);
    toast.warning("Promotion changed elsewhere. Loading the latest version.");
    return;
  }
  toast.error(getServerFnError(error, fallback));
}

export function useCreatePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePromotionDraftInput) =>
      apiData(postApiV1AdminPromotions({ body })),
    onSuccess: () => {
      invalidatePromotion(queryClient);
      toast.success("Promotion draft created");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not create the promotion draft."),
    ),
  });
}

export function useUpdatePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePromotionDraftInput }) =>
      apiData(putApiV1AdminPromotionsById({ path: { id }, body: input })),
    onSuccess: (_result, variables) => {
      invalidatePromotion(queryClient, variables.id);
      toast.success("Promotion saved");
    },
    onError: (error, variables) => {
      handlePromotionMutationError(
        error,
        queryClient,
        variables.id,
        "Could not save the promotion. Reload before retrying.",
      );
    },
  });
}

export function usePreviewPromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } &
      ApiBody<typeof postApiV1AdminPromotionsByIdPreview>) =>
      apiData(postApiV1AdminPromotionsByIdPreview({ path: { id }, body })),
    onError: (error, variables) => {
      handlePromotionMutationError(
        error,
        queryClient,
        variables.id,
        "Could not preview the promotion.",
      );
    },
  });
}

export function useActivatePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: PromotionRevisionClaim) =>
      apiData(postApiV1AdminPromotionsByIdActivate({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_result, variables) => {
      invalidatePromotion(queryClient, variables.id);
      toast.success("Promotion activated");
    },
    onError: (error, variables) => {
      handlePromotionMutationError(
        error,
        queryClient,
        variables.id,
        "Could not activate the promotion.",
      );
    },
  });
}

export function usePausePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: PromotionRevisionClaim) =>
      apiData(postApiV1AdminPromotionsByIdPause({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_result, variables) => {
      invalidatePromotion(queryClient, variables.id);
      toast.success("Promotion paused");
    },
    onError: (error, variables) => {
      handlePromotionMutationError(
        error,
        queryClient,
        variables.id,
        "Could not pause the promotion.",
      );
    },
  });
}

export function useDeletePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: PromotionRevisionClaim) =>
      apiData(deleteApiV1AdminPromotionsById({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.promotions.list(),
      });
      queryClient.removeQueries({
        queryKey: queryKeys.promotions.detail(variables.id),
      });
      toast.success("Promotion archived");
    },
    onError: (error, variables) => {
      handlePromotionMutationError(
        error,
        queryClient,
        variables.id,
        "Could not archive the promotion.",
      );
    },
  });
}

export const useArchivePromotion = useDeletePromotion;
